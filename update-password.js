const bcrypt = require('bcryptjs');
const pool = require('./db');

async function atualizarSenhaAdmin() {
    try {
        const novaSenha = 'admin123';
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(novaSenha, saltRounds);

        const query = 'UPDATE usuarios SET senha = $1 WHERE usuario = $2';
        await pool.query(query, [hashedPassword, 'admin']);

        console.log('Palavra-passe do administrador atualizada com sucesso para "admin123"!');
        process.exit(0);
    } catch (err) {
        console.error('Erro ao atualizar a palavra-passe:', err);
        process.exit(1);
    }
}

atualizarSenhaAdmin();