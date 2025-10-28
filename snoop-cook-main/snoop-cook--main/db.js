
// aquí es donde se conecta a la base que queremos 
const { Pool } = require('pg');

const pool = new Pool({
  user: 'elusuario',          // usuario
  host: 'localhost',
  database: 'nameBD',     // BD
  password: 'tucontra', // contraseña
  port: 5432
});

module.exports = pool;
