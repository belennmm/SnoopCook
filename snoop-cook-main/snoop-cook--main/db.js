
// aquí es donde se conecta a la base que queremos 
const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',          // usuario
  host: 'localhost',
  database: 'SnoopCook',     // BD
  password: '*****', // contraseña
  port: 5432
});

module.exports = pool;
