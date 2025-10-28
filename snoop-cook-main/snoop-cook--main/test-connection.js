// para saber si sí nos conectamos bien o no a la base 
const pool = require('./db');

async function testConnection(){
  try {
    const res = await pool.query('SELECT NOW();');
    console.log('✅ ¡Todo bien! La conexión a PostgreSQL es exitosa');
    console.log('Hora del servidor:', res.rows[0].now);
  } catch (err) {
    console.error('Error al conectar a PostgreSQL:', err.message);
  } finally {
    await pool.end();
  }
}

testConnection();
