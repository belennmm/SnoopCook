const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// debug
app.use((req,res,next)=>{ console.log(req.method, req.url); next(); });

// ========== CONFIG secret ======
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_superseguro';

// ====== AUTHORIZED  ====-==
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.rol)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    next();
  };
}

// ====== EL PING ==========
app.get('/api/ping', async (_req, res) => {
  try {
    const r = await pool.query('SELECT NOW()');
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'DB down' });
  }
});

// ====== DL LOGIN ======
app.post('/api/login', async (req, res) => {
  const { nombre_usuario, pass } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT id, id_empleado, nombre_usuario, pass, rol FROM usuario_sistema WHERE lower(nombre_usuario)=lower($1)',
      [nombre_usuario]
    );
    if (!rows.length) return res.status(401).json({ error: 'Usuario o contraseña inválidos' });

    const user = rows[0];
    const ok = await bcrypt.compare(pass, user.pass);
    if (!ok) return res.status(401).json({ error: 'Usuario o contraseña inválidos' });

    const token = jwt.sign(
      { id: user.id, id_empleado: user.id_empleado, rol: user.rol, nombre_usuario: user.nombre_usuario },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token, rol: user.rol, nombre_usuario: user.nombre_usuario });
  } catch (e) {
    console.error('LOGIN error', e);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

// ========== ==== CREAR USUARIO - esto solo gerente tiene para hacer ======
app.post('/api/usuarios', auth, requireRole('gerente'), async (req, res) => {
  try {
    const { nombre_usuario, pass, rol } = req.body || {};
    if (!nombre_usuario || !pass || !rol) {
      return res.status(400).json({ error: 'Faltan campos' });
    }
    if (!['gerente', 'empleado'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    const hash = await bcrypt.hash(pass, 10);

    const sql = `
      insert into usuario_sistema (id_empleado, nombre_usuario, pass, rol)
      values (null, $1, $2, $3)
      on conflict ((lower(nombre_usuario))) do nothing
      returning id, nombre_usuario, rol;
    `;
    const { rows } = await pool.query(sql, [nombre_usuario, hash, rol]);

    if (rows.length === 0) {
      return res.status(409).json({ error: 'El usuario ya existe' });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error('POST /api/usuarios error', e);
    res.status(500).json({ error: 'Error creando usuario' });
  }
});

// ====== cats ======
app.get('/api/mesas', async (_req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, id_sede, capacidad, disponible FROM mesa ORDER BY id_sede, id'
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error listando mesas' });
  }
});


app.get('/api/productos', async (_req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, nombre, precio::float AS precio FROM producto WHERE disponible = true ORDER BY tipo, nombre'
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error listando productos' });
  }
});

// ============ PEDIDOS ==================
// de /api/pedidoss
// ====== pedidos intento 2 con ayuda  ======
app.post('/api/pedidos', async (req, res) => {
  const client = await pool.connect();
  try {
    const { mesa_id, items } = req.body;
    if (!mesa_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    // 1) Obtener sede
    const m = await client.query('SELECT id_sede FROM mesa WHERE id=$1', [mesa_id]);
    if (m.rowCount === 0) return res.status(400).json({ error: 'Mesa inválida' });
    const id_sede = m.rows[0].id_sede;

    // 2) Resolver cliente por reserva del día/mesa (si existe)
    const q = `
      SELECT COALESCE(r.id_cliente, c.id) AS cliente_id
      FROM reserva r
      LEFT JOIN cliente c ON c.dpi = r.dpi
      WHERE r.id_mesa = $1
        AND r.inicio::date = CURRENT_DATE
      ORDER BY r.inicio DESC
      LIMIT 1
    `;
    const rcli = await client.query(q, [mesa_id]);
    const clienteId = rcli.rows[0]?.cliente_id || null;

    await client.query('BEGIN');

    // 3) Crear pedido (UNA sola inserción) ya con id_cliente
    const ins = await client.query(
      `INSERT INTO pedido (id_cliente, id_mesa, id_sede, fecha, estado, tipo, total)
       VALUES ($1, $2, $3, NOW(), 'abierto', 'mesa', 0)
       RETURNING id`,
      [clienteId, mesa_id, id_sede]
    );
    const pedidoId = ins.rows[0].id;

    // 4) Insertar items
    let total = 0;
    for (const it of items) {
      const prod = await client.query(
        `SELECT precio FROM producto WHERE id=$1 AND disponible=TRUE`,
        [it.producto_id]
      );
      if (prod.rowCount === 0) throw new Error('Producto inválido o no disponible');

      const precio = Number(prod.rows[0].precio);
      const cant   = Math.max(1, Number(it.cantidad || 1));
      total += precio * cant;

      await client.query(
        `INSERT INTO info_pedido (id_pedido, id_producto, cantidad, precio_unitario)
         VALUES ($1,$2,$3,$4)`,
        [pedidoId, it.producto_id, cant, precio]
      );
      // El trigger se encarga de descontar inventario
    }

    // 5) Actualizar total
    await client.query(`UPDATE pedido SET total=$1 WHERE id=$2`, [total, pedidoId]);

    await client.query('COMMIT');
    res.json({ ok:true, pedido_id: pedidoId, total });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/pedidos', e);
    res.status(500).json({ error: e.message || 'No se pudo registrar el pedido' });
  } finally {
    client.release();
  }
});



// ====== para que jale el back ======
const PORT = 3000;
app.listen(PORT, () => console.log(`✅ Servidor en http://localhost:${PORT}`));

// las mesas disponibles por sede/capacidad/rango 
app.get('/api/mesas-disponibles', async (req, res) => {
  try {
    const sede_id   = Number(req.query.sede_id);
    const capacidad = Number(req.query.capacidad);
    const inicio    = req.query.inicio; 
    const fin       = req.query.fin;    // 

     console.log('MESAS DISP PARAMS =>', { sede_id, capacidad, inicio, fin }); 

    if (!sede_id || !capacidad || !inicio || !fin) {
      return res.status(400).json({ error: 'Parámetros requeridos' });
    }
    const q = `SELECT * FROM fn_mesas_disponibles($1,$2,$3::timestamptz,$4::timestamptz)`;
    const { rows } = await pool.query(q, [sede_id, capacidad, inicio, fin]);
    res.json(rows);
  } catch (e) {
    console.error('GET /api/mesas-disponibles', e);
    res.status(500).json({ error: 'Error consultando disponibilidad' });
  }
});

// -----------------------------------------------------------------------------------
// crea la reserva ya sea online o walk-in
app.post('/api/reservas', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      nombre, telefono, correo, dpi,
      sede_id, mesa_id, inicio, fin, // aquí para walk-in el final null
      capacidad, observaciones
    } = req.body || {};

    if (!dpi || !sede_id || !mesa_id) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    await client.query('BEGIN');

    // cliente por dpi
    const up = await client.query(
      `SELECT fn_upsert_cliente($1,$2,$3,$4) AS id`,
      [dpi, nombre || null, telefono || null, correo || null]
    );
    const id_cliente = up.rows[0].id;

    //  si fin es null entonces → walk-in
    // 
const isWalkin = (fin == null);

const ins = await client.query(
  `INSERT INTO reserva
     (id_mesa, id_cliente, id_sede, id_empleado, capacidad,
      observaciones, inicio, fin, visita, estado, dpi, nombre_cliente)
   VALUES
     ($1,$2,$3,NULL,$4,$5,$6::timestamptz,$7::timestamptz,$8::boolean,NULL,$9,$10)
   RETURNING id, inicio, fin, estado, visita`,
  [
    mesa_id, id_cliente, sede_id, capacidad || null,
    observaciones || null,
    inicio || null,                
    isWalkin ? null : fin || null,
    isWalkin,                      
    dpi,
    nombre || null
  ]
);


    await client.query('COMMIT');
    res.json(ins.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/reservas', e);
    res.status(500).json({ error: e.message || 'No se pudo crear la reserva' });
  } finally {
    client.release();
  }
});


app.get('/api/sedes', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, nombre FROM sede ORDER BY nombre'
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/sedes', e);
    res.status(500).json({ error: 'Error listando sedes' });
  }
});

// capacidad de sede por persona 
app.get('/api/capacidades', async (req, res) => {
  try {
    const sede_id = Number(req.query.sede_id);
    if (!sede_id) return res.status(400).json({ error: 'sede_id requerido' });

    const { rows } = await pool.query(
      `SELECT DISTINCT capacidad
         FROM mesa
        WHERE id_sede = $1
        ORDER BY capacidad`,
      [sede_id]
    );
    res.json(rows); 
  } catch (e) {
    console.error('GET /api/capacidades', e);
    res.status(500).json({ error: 'Error listando capacidades' });
  }
});

// ====== EL ESTADO DE LA MESAA
// es el  /api/mesa/:id/estado
app.get('/api/mesa/:id/estado', async (req, res) => {
  const mesaId = Number(req.params.id);
  if (!mesaId) return res.status(400).json({ error: 'ID de mesa inválido' });

  try {
    const sql = `
      WITH m AS (
        SELECT id AS mesa_id, disponible
        FROM mesa
        WHERE id = $1
      ),
      actual AS (
        /* Reserva/visita actualmente ocupando la mesa:
           - Walk-in: visita_bool = TRUE y (sin fin o fin>now)
           - Reserva programada: visita_bool != TRUE, inicio<=now y (sin fin o fin>now)
           Estados ocupados: 'pendiente' o 'entregado'
        */
        SELECT r.id AS reserva_id, r.id_mesa AS mesa_id, r.estado, r.inicio, r.fin,
               COALESCE(c.nombre, r.nombre_cliente) AS cliente
        FROM reserva r
        LEFT JOIN cliente c ON c.id = r.id_cliente
        WHERE r.id_mesa = $1
          AND r.estado IN ('pendiente','entregado')
          AND (
            (r.visita_bool IS TRUE AND (r.fin IS NULL OR r.fin > NOW()))
            OR
            (r.visita_bool IS DISTINCT FROM TRUE
              AND r.inicio <= NOW()
              AND (r.fin IS NULL OR r.fin > NOW()))
          )
        ORDER BY r.inicio DESC
        LIMIT 1
      ),
      proxima AS (
        /* Próxima reserva programada (no walk-in) aún no iniciada */
        SELECT DISTINCT ON (r.id_mesa)
               r.id_mesa AS mesa_id,
               r.inicio  AS proxima_reserva_inicio,
               COALESCE(c.nombre, r.nombre_cliente) AS proxima_reserva_cliente
        FROM reserva r
        LEFT JOIN cliente c ON c.id = r.id_cliente
        WHERE r.id_mesa = $1
          AND r.estado = 'pendiente'
          AND r.visita_bool IS DISTINCT FROM TRUE
          AND r.inicio > NOW()
        ORDER BY r.id_mesa, r.inicio ASC
      )
      SELECT
        COALESCE(a.mesa_id, m.mesa_id, $1::int) AS mesa_id,
        a.reserva_id,
        a.estado,
        a.inicio,
        a.fin,
        a.cliente,
        p.proxima_reserva_inicio,
        p.proxima_reserva_cliente,
        m.disponible
      FROM m
      LEFT JOIN actual a ON a.mesa_id = m.mesa_id
      LEFT JOIN proxima p ON p.mesa_id = m.mesa_id
    `;
    const { rows } = await pool.query(sql, [mesaId]);
    const row = rows[0];

    if (!row) return res.json({ mesa_id: mesaId, estado: 'libre' });

    // SI YA hay reserva/visita actual tons el estado es el de esa reserva 
    if (row.reserva_id) {
      return res.json({
        mesa_id: row.mesa_id,
        reserva_id: row.reserva_id,
        estado: row.estado,           
        inicio: row.inicio,
        fin: row.fin,
        cliente: row.cliente,
        proxima_reserva_inicio: row.proxima_reserva_inicio,
        proxima_reserva_cliente: row.proxima_reserva_cliente
      });
    }

    
    return res.json({
      mesa_id: row.mesa_id,
      estado: row.disponible ? 'libre' : 'pendiente',
      proxima_reserva_inicio: row.proxima_reserva_inicio,
      proxima_reserva_cliente: row.proxima_reserva_cliente
    });

  } catch (e) {
    console.error('GET /api/mesa/:id/estado', e);
    res.status(500).json({ error: 'Error consultando estado de mesa' });
  }
});



// ================== PARA EL WALKIN  =========
app.post('/api/walkin', async (req, res) => {
  const client = await pool.connect();
  try {
    const { nombre, telefono, correo, dpi, sede_id, mesa_id, capacidad, observaciones } = req.body || {};
    if (!dpi || !sede_id || !mesa_id) {
      return res.status(400).json({ error: 'Faltan dpi, sede_id o mesa_id' });
    }

    await client.query('BEGIN');

    const up = await client.query(
      'SELECT fn_upsert_cliente($1,$2,$3,$4) AS id',
      [dpi, nombre || null, telefono || null, correo || null]
    );
    const id_cliente = up.rows[0].id;

    // SE HACE la reserva como walk-in con inicio y estado se ajustan por trigger 
    const q = `
      INSERT INTO reserva
        (id_mesa, id_cliente, id_sede, id_empleado, capacidad,
         observaciones, inicio, fin, visita, estado, dpi, nombre_cliente)
      VALUES
        ($1,$2,$3,NULL,$4,$5,NULL,NULL,NULL,NULL,$6,$7)
      RETURNING id, visita, estado, inicio
    `;
    const r = await client.query(q, [
      mesa_id, id_cliente, sede_id, capacidad || null, observaciones || null, dpi, nombre || null
    ]);

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/walkin', e);
    res.status(500).json({ error: e.message || 'No se pudo iniciar walk-in' });
  } finally {
    client.release();
  }
});
// ====== ACTUALIZA EL ESTADO DE L A MEAS======
// 
app.patch('/api/mesa/:id/estado', async (req, res) => {
  const mesaId = Number(req.params.id);
  const nuevo  = String(req.body?.estado || '').toLowerCase();

  const ALLOWED = ['pendiente', 'entregado', 'finalizada', 'cancelada'];
  if (!mesaId || !ALLOWED.includes(nuevo)) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ubica la reserva 
    const sel = `
      SELECT r.id
      FROM reserva r
      WHERE r.id_mesa = $1
        AND r.estado IN ('pendiente','entregado')
        AND (
          -- Walk-in: sin fin o fin>now
          (r.visita_bool IS TRUE AND (r.fin IS NULL OR r.fin > NOW()))
          OR
          -- Reserva programada: ya inició y no terminó
          (r.visita_bool IS DISTINCT FROM TRUE
            AND r.inicio <= NOW()
            AND (r.fin IS NULL OR r.fin > NOW()))
        )
      ORDER BY r.inicio DESC
      LIMIT 1;
    `;
    const cur = await client.query(sel, [mesaId]);

    if (['finalizada','cancelada'].includes(nuevo)) {
 
      if (cur.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'No hay reserva activa/pendiente para esta mesa' });
      }
      const rid = cur.rows[0].id;

      // se cierra la mesa 
      await client.query(
        `UPDATE reserva SET estado=$2, fin=NOW() WHERE id=$1`,
        [rid, nuevo]
      );
      await client.query(
        `UPDATE mesa SET disponible = TRUE WHERE id = $1`,
        [mesaId]
      );

      await client.query('COMMIT');
      return res.json({ mesa_id: mesaId, reserva_id: rid, estado: nuevo });
    }

    // si es cerrado
    if (cur.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No hay reserva/visita abierta para actualizar' });
    }
    const rid = cur.rows[0].id;

    await client.query(
      `UPDATE reserva SET estado=$2 WHERE id=$1`,
      [rid, nuevo]
    );
    // ocupada
    await client.query(
      `UPDATE mesa SET disponible = FALSE WHERE id = $1`,
      [mesaId]
    );

    await client.query('COMMIT');
    return res.json({ mesa_id: mesaId, reserva_id: rid, estado: nuevo });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('PATCH /api/mesa/:id/estado', e);
    return res.status(500).json({ error: 'Error actualizando estado' });
  } finally {
    client.release();
  }
});


//========= GUARDAR COMENT POR CLIENTE (LE VOY A PONER EL DPI BC ES EL ID)
app.post('/api/comentarios', async (req, res) => {
  try {
    const { dpi, comentario } = req.body || {};
    if (!dpi || !comentario) return res.status(400).json({ error: 'dpi y comentario requeridos' });
    if (comentario.length > 150) return res.status(400).json({ error: 'Máximo 150 caracteres' });

    await pool.query(
      `INSERT INTO bitacora_reserva (id_reserva, tipo, fecha_actual, id_cliente, nombre_cliente)
       SELECT r.id, 'comentario', CURRENT_DATE, c.id, c.nombre
       FROM cliente c
       LEFT JOIN reserva r ON r.dpi = c.dpi
       WHERE c.dpi = $1
       ORDER BY r.id DESC NULLS LAST
       LIMIT 1`,
      [dpi]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/comentarios', e);
    res.status(500).json({ error: 'No se pudo guardar el comentario' });
  }
});

// -------------------------------------------
//========= FAVS =========
// === el fav (no funciona bien)
app.get('/api/cliente/:dpi/favorito', async (req, res) => {
  try {
    const dpi = req.params.dpi;
    const r = await pool.query('SELECT producto_fav FROM cliente WHERE dpi=$1', [dpi]);
    if (!r.rowCount) return res.status(404).json({ error: 'Cliente no existe' });
    res.json({ producto_fav: r.rows[0].producto_fav });
  } catch (e) {
    console.error('GET /api/cliente/:dpi/favorito', e);
    res.status(500).json({ error: 'Error consultando favorito' });
  }
});

// === actualizar el fav (x2 no)
app.patch('/api/cliente/:dpi/favorito', async (req, res) => {
  try {
    const dpi = req.params.dpi;
    const { producto_fav } = req.body || {};
    if (!producto_fav) return res.status(400).json({ error: 'producto_fav requerido' });
    const u = await pool.query(
      'UPDATE cliente SET producto_fav=$1 WHERE dpi=$2 RETURNING producto_fav',
      [producto_fav, dpi]
    );
    if (!u.rowCount) return res.status(404).json({ error: 'Cliente no existe' });
    res.json(u.rows[0]);
  } catch (e) {
    console.error('PATCH /api/cliente/:dpi/favorito', e);
    res.status(500).json({ error: 'No se pudo actualizar favorito' });
  }
});



// ====== VISITASSSSS PERO SOLO DE AHORITA BUENO DE HOY=====
app.get('/api/visitas-hoy', async (_req, res) => {
  try {
    const sql = `
      SELECT
        r.id              AS reserva_id,
        r.id_mesa         AS mesa_id,
        COALESCE(r.estado,'') AS estado,
        r.inicio,
        r.fin,
        r.visita,
        c.nombre          AS cliente
      FROM reserva r
      LEFT JOIN cliente c ON c.id = r.id_cliente
      WHERE r.inicio::date = CURRENT_DATE
        AND COALESCE(r.estado,'') NOT IN ('cancelada','finalizada')
      ORDER BY r.inicio ASC NULLS LAST, r.id_mesa;
    `;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (e) {
    console.error('GET /api/visitas-hoy', e);
    res.status(500).json({ error: 'Error listando visitas' });
  }
});

app.post('/api/walkin', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      nombre, telefono, correo, dpi,
      sede_id, mesa_id,
      capacidad,            
      inicio,               
      observaciones     
    } = req.body || {};

    if (!dpi || !sede_id || !mesa_id || !inicio) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    await client.query('BEGIN');

    // cliente por DPI
    const up = await client.query(
      'SELECT fn_upsert_cliente($1,$2,$3,$4) AS id',
      [dpi, nombre || null, telefono || null, correo || null]
    );
    const id_cliente = up.rows[0].id;

    // INSERTS de reserva
    const ins = await client.query(`
      INSERT INTO reserva
        (id_mesa, id_cliente, id_sede, capacidad, observaciones,
         inicio, fin, visita_bool, estado, dpi, nombre_cliente)
      VALUES
        ($1, $2, $3, $4, $5,
         $6::timestamptz, NULL, TRUE, 'activa', $7, $8)
      RETURNING id, estado, inicio, fin, visita_bool
    `, [
      mesa_id, id_cliente, sede_id, capacidad || null, observaciones || null,
      inicio, dpi, nombre || null
    ]);

    await client.query('COMMIT');
    res.json(ins.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/walkin', e);
    res.status(500).json({ error: e.message || 'No se pudo iniciar el walk-in' });
  } finally {
    client.release();
  }
});


app.patch('/api/mesa/:id/cerrar', async (req, res) => {
  const idMesa = Number(req.params.id);
  if (!idMesa) return res.status(400).json({ error: 'ID mesa inválido' });

  try {
    const q = `
      UPDATE reserva
         SET estado = 'finalizada', fin = NOW()
       WHERE id = (
         SELECT r.id
           FROM reserva r
          WHERE r.id_mesa = $1
            AND COALESCE(r.estado,'') IN ('activa','pendiente')
          ORDER BY r.inicio DESC
          LIMIT 1
       )
      RETURNING id, estado, fin;
    `;
    const { rows } = await pool.query(q, [idMesa]);
    if (!rows.length) return res.status(404).json({ error: 'No hay reserva activa para esa mesa' });
    res.json(rows[0]);
  } catch (e) {
    console.error('PATCH /api/mesa/:id/cerrar', e);
    res.status(500).json({ error: 'No se pudo cerrar la mesa' });
  }
});

// para los favoritos intento 2
app.get('/api/cliente/:dpi/favoritos', async (req, res) => {
  try {
    const dpi = req.params.dpi;
    const q = `
      SELECT cf.categoria, cf.id_producto, cf.producto, cf.conteo, cf.actualizado
      FROM cliente_favorito cf
      JOIN cliente c ON c.id = cf.id_cliente
      WHERE c.dpi = $1
      ORDER BY cf.categoria;
    `;
    const { rows } = await pool.query(q, [dpi]);

  
    const out = { Bebida:null, Galleta:null, Salado:null };
    for (const r of rows) {
      out[r.categoria] = {
        id_producto: r.id_producto,
        producto: r.producto,
        conteo: r.conteo,
        actualizado: r.actualizado
      };
    }
    res.json(out);
  } catch (e) {
    console.error('GET /cliente/:dpi/favoritos', e);
    res.status(500).json({ error: 'Error consultando favoritos' });
  }
});

// historial DPIs momentáneo no funciona
app.get('/api/cliente/:dpi/historial', async (req, res) => {
  try {
    const dpi = req.params.dpi;
    const q = `
      SELECT *
      FROM public.vw_historial_cliente
      WHERE dpi = $1
      ORDER BY fecha DESC
      LIMIT 200;
    `;
    const { rows } = await pool.query(q, [dpi]);
    res.json(rows);
  } catch (e) {
    console.error('GET /cliente/:dpi/historial', e);
    res.status(500).json({ error: 'Error consultando historial' });
  }
});

// favs 300 mil con ayuda 
app.post('/api/cliente/:dpi/favoritos/recalcular', async (req, res) => {
  const client = await pool.connect();
  try {
    const dpi = req.params.dpi;

    // localiza el cliente 
    const c = await client.query('SELECT id FROM cliente WHERE dpi=$1', [dpi]);
    if (!c.rowCount) return res.status(404).json({ error: 'Cliente no existe' });
    const idCliente = c.rows[0].id;

    await client.query('BEGIN');

    // consumos del dpi bueno del cliente
    const consumoSql = `
      WITH base AS (
        SELECT
          p.id_cliente,
          pr.tipo               AS categoria,
          pr.id                 AS id_producto,
          pr.nombre             AS producto,
          COUNT(*)              AS veces,
          MAX(p.fecha)          AS ultima
        FROM public.pedido p
        JOIN public.info_pedido ip ON ip.id_pedido = p.id
        JOIN public.producto   pr ON pr.id = ip.id_producto
        WHERE p.id_cliente = $1
        GROUP BY p.id_cliente, pr.tipo, pr.id, pr.nombre
      ),
      top_cat AS (
        -- Por categoría, toma el de mayor conteo; desempate: más reciente
        SELECT DISTINCT ON (categoria)
               categoria, id_producto, producto, veces, ultima
        FROM base
        ORDER BY categoria, veces DESC, ultima DESC
      ),
      ultimos AS (
        -- Si no hay repetidos en una categoría, cae aquí: lo último que pidió en esa categoría
        SELECT DISTINCT ON (pr.tipo)
               pr.tipo         AS categoria,
               pr.id           AS id_producto,
               pr.nombre       AS producto,
               1               AS veces,
               p.fecha         AS ultima
        FROM public.pedido p
        JOIN public.info_pedido ip ON ip.id_pedido = p.id
        JOIN public.producto   pr ON pr.id = ip.id_producto
        WHERE p.id_cliente = $1
        ORDER BY pr.tipo, p.fecha DESC
      ),
      mix AS (
        -- Une "top" con "últimos": si hay top, gana top; si no, use último
        SELECT * FROM top_cat
        UNION
        SELECT u.*
        FROM ultimos u
        WHERE NOT EXISTS (SELECT 1 FROM top_cat t WHERE t.categoria = u.categoria)
      )
      SELECT categoria, id_producto, producto, veces
      FROM mix;
    `;
    const cons = await client.query(consumoSql, [idCliente]);

    // según las 3 categorías 
    const favs = { Bebida: null, Galleta: null, Salado: null };
    for (const r of cons.rows) {
      if (favs.hasOwnProperty(r.categoria)) {
        favs[r.categoria] = {
          id_producto: r.id_producto,
          producto:    r.producto,
          conteo:      Number(r.veces) || 1
        };
      }
    }

    //se busca uno por categoria y si no hay pues es null
    const cats = ['Bebida', 'Galleta', 'Salado'];
    for (const cat of cats) {
      const fav = favs[cat];
      if (fav) {
        await client.query(
          `INSERT INTO cliente_favorito (id_cliente, categoria, id_producto, producto, conteo, actualizado)
           VALUES ($1,$2,$3,$4,$5, NOW())
           ON CONFLICT (id_cliente, categoria)
           DO UPDATE SET id_producto = EXCLUDED.id_producto,
                         producto    = EXCLUDED.producto,
                         conteo      = EXCLUDED.conteo,
                         actualizado = NOW()`,
          [idCliente, cat, fav.id_producto, fav.producto, fav.conteo]
        );
      } else {
       // me dio la opción de vaciar si no hay consumo 
        await client.query(
          `INSERT INTO cliente_favorito (id_cliente, categoria, id_producto, producto, conteo, actualizado)
           VALUES ($1,$2,NULL,NULL,NULL, NOW())
           ON CONFLICT (id_cliente, categoria)
           DO UPDATE SET id_producto = NULL,
                         producto    = NULL,
                         conteo      = NULL,
                         actualizado = NOW()`,
          [idCliente, cat]
        );
      }
    }

    await client.query('COMMIT');

    // con esto se muestran los favs
    const out = await client.query(
      `SELECT categoria, id_producto, producto, conteo, actualizado
         FROM cliente_favorito
        WHERE id_cliente=$1
        ORDER BY categoria`, [idCliente]);

    // del front 
    const resp = { Bebida:null, Galleta:null, Salado:null };
    for (const r of out.rows) {
      resp[r.categoria] = r.id_producto ? {
        id_producto: r.id_producto,
        producto:    r.producto,
        conteo:      r.conteo,
        actualizado: r.actualizado
      } : null;
    }
    res.json(resp);

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/cliente/:dpi/favoritos/recalcular', e);
    res.status(500).json({ error: e.message || 'Error recalculando favoritos' });
  } finally {
    client.release();
  }
});

// ---------------------- GERENTE -------------

// el top 10 productos vendidos
app.get('/api/gerente/top-productos', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.vista_top10_productos_vendidos;');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error consultando top productos' }); }
});

// for  10 clientes más frecuentes -por pedidos
app.get('/api/gerente/top-clientes', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.vista_top10_clientes_frecuentes;');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error consultando top clientes' }); }
});

// el top 5 clientes por reservas + favoritos por categoría
app.get('/api/gerente/top-clientes-reservas', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.obtener_top5_clientes_reservas_y_favoritos();');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error consultando top reservas/favoritos' }); }

  // favs sucursales 
  app.get('/api/gerente/sucursales', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.vista_comportamiento_sucursales;');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error consultando comportamiento por sede' }); }
});
});

//// los críticos 
  app.get('/api/gerente/insumos-criticos', async (req, res) => {
    try {
      const sede = req.query.sede ? Number(req.query.sede) : null;
      const dias = req.query.dias ? Number(req.query.dias) : 7; // algo por default
      const { rows } = await pool.query(
        'SELECT * FROM public.obtener_insumos_criticos($1,$2);',
        [sede, dias]
      );
      res.json(rows);
    } catch (e) {
      console.error('GET /api/gerente/insumos-criticos', e);
      res.status(500).json({ error: 'Error consultando insumos críticos' });
    }
  });

// --- para lo de insumooos ---
app.get('/api/ingredientes', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, nombre, unidad FROM public.ingrediente ORDER BY nombre;`);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Error listando ingredientes' }); }
});

app.get('/api/proveedores', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, nombre FROM public.proveedor ORDER BY nombre;`);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Error listando proveedores' }); }
});

app.get('/api/sedes', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, nombre FROM public.sede ORDER BY id;`);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Error listando sedes' }); }
});

// ---- gerente puts insumos ------
app.post('/api/inventario/ingreso-directo', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      id_ingrediente, id_sede, id_proveedor,
      cantidad, vencimiento, estado_lote, ingreso
    } = req.body || {};

    if (!id_ingrediente || !id_sede || !id_proveedor || !cantidad || !vencimiento) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const q = `SELECT * FROM public.fn_ingreso_directo_lote($1,$2,$3,$4,$5,$6,$7);`;
    const { rows } = await client.query(q, [
      Number(id_ingrediente), Number(id_sede), Number(id_proveedor),
      Number(cantidad), vencimiento, estado_lote || 'fresco', ingreso || null
    ]);
    res.json({ ok:true, id_lote: rows[0]?.id_lote });
  } catch (e) {
    console.error('POST /api/inventario/ingreso-directo', e);
    res.status(500).json({ error: 'No se pudo ingresar el lote' });
  } finally {
    client.release();
  }
});
