const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  throw new Error('A variável DATABASE_URL deve ser configurada no ambiente.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c timezone=America/Sao_Paulo',
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