// seed-users.js
const bcrypt = require('bcrypt');
const pool = require('./db');

(async () => {
  try {
    const passGer = await bcrypt.hash('Gerente123', 10);
    const passEmp = await bcrypt.hash('Empleado123', 10);

    await pool.query(
      `
      INSERT INTO usuario_sistema (id_empleado, nombre_usuario, pass, rol)
      VALUES (NULL, 'gerente', $1, 'gerente')
      ON CONFLICT (lower(nombre_usuario)) DO NOTHING;
      `,
      [passGer]
    );

    await pool.query(
      `
      INSERT INTO usuario_sistema (id_empleado, nombre_usuario, pass, rol)
      VALUES (NULL, 'empleado', $1, 'empleado')
      ON CONFLICT (lower(nombre_usuario)) DO NOTHING;
      `,
      [passEmp]
    );

    console.log('Usuarios creados/ya existían ✅');
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
})();
