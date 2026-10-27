const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.connect((err, client, release) => {
  if (err) {
    return console.error('Erro ao conectar ao Supabase:', err.stack);
  }
  console.log('Ligação bem-sucedida ao Supabase!');
  release();
});

module.exports = pool;