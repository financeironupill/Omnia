const pool = require('./db');

async function verificarUtilizador() {
    try {
        const resultado = await pool.query('SELECT * FROM usuarios');
        console.log('Utilizadores encontrados na base de dados:', resultado.rows);
        process.exit(0);
    } catch (err) {
        console.error('Erro ao consultar a base de dados:', err);
        process.exit(1);
    }
}

verificarUtilizador();