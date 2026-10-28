const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'omnia_chave_secreta_2026',
    resave: false,
    saveUninitialized: false
}));

function formatarCapitalizacao(texto) {
    if (!texto) return '';
    return texto.trim().toLowerCase().split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function gerarNumeroOcorrencia() {
    const a = new Date();
    return `${a.getFullYear()}${String(a.getMonth() + 1).padStart(2, '0')}${Math.floor(1000 + Math.random() * 9000)}`;
}

function verificarAutenticacao(req, res, next) {
    if (req.session.usuario) return next();
    res.redirect('/login');
}

function verificarAdmin(req, res, next) {
    if (req.session.usuario && req.session.usuario.nivel === 'Administrador') return next();
    res.redirect('/dashboard?erro=Apenas Administradores.');
}

app.get('/login', (req, res) => res.render('login', { erro: null }));

app.post('/login', async (req, res) => {
    const { usuario, senha } = req.body;
    try {
        const r = await pool.query('SELECT * FROM usuarios WHERE UPPER(TRIM(usuario)) = $1', [usuario ? usuario.trim().toUpperCase() : '']);
        if (r.rows.length === 0 || !await bcrypt.compare(senha, r.rows[0].senha)) {
            return res.render('login', { erro: 'Utilizador ou palavra-passe incorretos.' });
        }
        req.session.usuario = { id: r.rows[0].id, nome: r.rows[0].nome, usuario: r.rows[0].usuario, nivel: r.rows[0].nivel };
        res.redirect('/dashboard');
    } catch (e) {
        res.render('login', { erro: 'Erro interno.' });
    }
});

app.get('/dashboard', verificarAutenticacao, (req, res) => res.render('dashboard', { usuario: req.session.usuario, erro: req.query.erro || null }));
app.get('/solucao', verificarAutenticacao, (req, res) => res.render('dashboard-solucao', { usuario: req.session.usuario }));

// UTILIZADORES
app.get('/usuarios', verificarAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, nome, usuario, nivel FROM usuarios ORDER BY nome ASC');
        res.render('usuarios-lista', { usuarios: result.rows, erro: null, sucesso: null });
    } catch (err) {
        res.status(500).send('Erro interno');
    }
});

app.get('/usuarios/novo', verificarAdmin, (req, res) => {
    res.render('usuario-form', { usuario: null });
});

app.post('/usuarios/novo', verificarAdmin, async (req, res) => {
    const { nome, usuario, senha, nivel } = req.body;
    try {
        const hash = await bcrypt.hash(senha, 10);
        const sql = 'INSERT INTO usuarios (nome, usuario, senha, nivel) VALUES ($1, $2, $3, $4)';
        await pool.query(sql, [formatarCapitalizacao(nome), usuario ? usuario.trim().toLowerCase() : '', hash, nivel]);
        res.redirect('/usuarios?sucesso=Utilizador cadastrado com sucesso!');
    } catch (err) {
        res.redirect('/usuarios?erro=Erro ao cadastrar.');
    }
});

app.get('/usuarios/editar/:id', verificarAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, nome, usuario, nivel FROM usuarios WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.redirect('/usuarios?erro=Não encontrado.');
        res.render('usuario-form', { usuario: result.rows[0] });
    } catch (err) {
        res.redirect('/usuarios?erro=Erro ao carregar.');
    }
});

app.post('/usuarios/editar/:id', verificarAdmin, async (req, res) => {
    const { nome, usuario, senha, nivel } = req.body;
    try {
        if (senha && senha.trim() !== '') {
            const hash = await bcrypt.hash(senha, 10);
            const sql = 'UPDATE usuarios SET nome = $1, usuario = $2, senha = $3, nivel = $4 WHERE id = $5';
            await pool.query(sql, [formatarCapitalizacao(nome), usuario ? usuario.trim().toLowerCase() : '', hash, nivel, req.params.id]);
        } else {
            const sql = 'UPDATE usuarios SET nome = $1, usuario = $2, nivel = $3 WHERE id = $4';
            await pool.query(sql, [formatarCapitalizacao(nome), usuario ? usuario.trim().toLowerCase() : '', nivel, req.params.id]);
        }
        res.redirect('/usuarios?sucesso=Utilizador atualizado com sucesso!');
    } catch (err) {
        res.redirect('/usuarios?erro=Erro ao atualizar.');
    }
});

app.post('/usuarios/excluir/:id', verificarAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
        res.redirect('/usuarios?sucesso=Excluído!');
    } catch (err) {
        res.redirect('/usuarios?erro=Erro ao excluir.');
    }
});

// TRANSPORTADORAS
app.get('/transportadoras', verificarAutenticacao, async (req, res) => {
    try {
        const { busca, ordenar, ordem } = req.query;
        let col = ordenar === 'cnpj' ? 'cnpj' : (ordenar === 'nome' ? 'nome' : 'id');
        let dir = ordem === 'ASC' ? 'ASC' : 'DESC';
        let query = 'SELECT * FROM transportadoras';
        let params = [];
        if (busca && busca.trim() !== '') {
            query += ' WHERE nome ILIKE $1 OR nome_fantasia ILIKE $1 OR cnpj ILIKE $1';
            params.push('%' + busca.trim() + '%');
        }
        query += ' ORDER BY ' + col + ' ' + dir;
        const result = await pool.query(query, params);
        res.render('transportadoras-lista', { transportadoras: result.rows, buscaAtual: busca || '', ordenarAtual: col, ordemAtual: dir, erro: null, sucesso: null });
    } catch (err) {
        res.status(500).send('Erro interno');
    }
});

app.get('/transportadoras/nova', verificarAutenticacao, (req, res) => {
    res.render('transportadora-form', { transportadora: null });
});

app.post('/transportadoras/novo', verificarAutenticacao, async (req, res) => {
    const { cnpj, nome, nome_fantasia, contato, email, telefone, cidade, uf } = req.body;
    try {
        const sql = 'INSERT INTO transportadoras (cnpj, nome, nome_fantasia, contato, email, telefone, cidade, uf, ativo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)';
        await pool.query(sql, [cnpj ? cnpj.replace(/\D/g, '') : '', formatarCapitalizacao(nome), formatarCapitalizacao(nome_fantasia), formatarCapitalizacao(contato), email ? email.trim().toLowerCase() : '', telefone, formatarCapitalizacao(cidade), uf ? uf.trim().toUpperCase() : '']);
        res.redirect('/transportadoras?sucesso=Cadastrada com sucesso!');
    } catch (err) {
        res.redirect('/transportadoras?erro=Erro ao cadastrar.');
    }
});

app.get('/transportadoras/editar/:id', verificarAutenticacao, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM transportadoras WHERE id = $1', [req.params.id]);
        res.render('transportadora-form', { transportadora: result.rows[0] });
    } catch (err) {
        res.redirect('/transportadoras?erro=Erro ao carregar.');
    }
});

app.post('/transportadoras/editar/:id', verificarAutenticacao, async (req, res) => {
    const { cnpj, nome, nome_fantasia, contato, email, telefone, cidade, uf } = req.body;
    try {
        const sql = 'UPDATE transportadoras SET cnpj = $1, nome = $2, nome_fantasia = $3, contato = $4, email = $5, telefone = $6, cidade = $7, uf = $8 WHERE id = $9';
        await pool.query(sql, [cnpj ? cnpj.replace(/\D/g, '') : '', formatarCapitalizacao(nome), formatarCapitalizacao(nome_fantasia), formatarCapitalizacao(contato), email ? email.trim().toLowerCase() : '', telefone, formatarCapitalizacao(cidade), uf ? uf.trim().toUpperCase() : '', req.params.id]);
        res.redirect('/transportadoras?sucesso=Atualizada com sucesso!');
    } catch (err) {
        res.redirect('/transportadoras?erro=Erro ao atualizar.');
    }
});

app.post('/transportadoras/excluir/:id', verificarAutenticacao, async (req, res) => {
    try {
        await pool.query('DELETE FROM transportadoras WHERE id = $1', [req.params.id]);
        res.redirect('/transportadoras?sucesso=Excluída!');
    } catch (err) {
        res.redirect('/transportadoras?erro=Erro ao excluir.');
    }
});

// CLIENTES (Com suporte a origem dinâmica para o botão Voltar)
app.get('/clientes', verificarAutenticacao, async (req, res) => {
    try {
        const { busca, ordenar, ordem, origem } = req.query;
        let col = ordenar === 'cnpj_cpf' ? 'cnpj_cpf' : (ordenar === 'nome' ? 'nome' : 'id');
        let dir = ordem === 'ASC' ? 'ASC' : 'DESC';
        let query = 'SELECT * FROM clientes';
        let params = [];
        if (busca && busca.trim() !== '') {
            query += ' WHERE nome ILIKE $1 OR nome_fantasia ILIKE $1 OR cnpj_cpf ILIKE $1';
            params.push('%' + busca.trim() + '%');
        }
        query += ' ORDER BY ' + col + ' ' + dir;
        const result = await pool.query(query, params);
        res.render('clientes-lista', { 
            clientes: result.rows, 
            buscaAtual: busca || '', 
            ordenarAtual: col, 
            ordemAtual: dir, 
            origemAtual: origem || 'dashboard', 
            erro: null, 
            sucesso: null 
        });
    } catch (err) {
        res.status(500).send('Erro interno');
    }
});

app.get('/clientes/novo', verificarAutenticacao, (req, res) => {
    res.render('cliente-form', { cliente: null });
});

app.post('/clientes/novo', verificarAutenticacao, async (req, res) => {
    const { tipo_pessoa, cnpj_cpf, nome, nome_fantasia, contato, email, telefone, cidade, uf, banco, agencia, conta, tipo_chave_pix, chave_pix } = req.body;
    try {
        const sql = 'INSERT INTO clientes (tipo_pessoa, cnpj_cpf, nome, nome_fantasia, contato, email, telefone, cidade, uf, banco, agencia, conta, tipo_chave_pix, chave_pix, ativo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1)';
        await pool.query(sql, [tipo_pessoa, cnpj_cpf ? cnpj_cpf.replace(/\D/g, '') : '', formatarCapitalizacao(nome), formatarCapitalizacao(nome_fantasia), formatarCapitalizacao(contato), email ? email.trim().toLowerCase() : '', telefone, formatarCapitalizacao(cidade), uf ? uf.trim().toUpperCase() : '', formatarCapitalizacao(banco), agencia, conta, tipo_chave_pix, chave_pix]);
        res.redirect('/clientes?sucesso=Cadastrado com sucesso!');
    } catch (err) {
        res.redirect('/clientes?erro=Erro ao cadastrar.');
    }
});

app.get('/clientes/editar/:id', verificarAutenticacao, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.redirect('/clientes?erro=Não encontrado.');
        res.render('cliente-form', { cliente: result.rows[0] });
    } catch (err) {
        res.redirect('/clientes?erro=Erro ao carregar.');
    }
});

app.post('/clientes/editar/:id', verificarAutenticacao, async (req, res) => {
    const { tipo_pessoa, cnpj_cpf, nome, nome_fantasia, contato, email, telefone, cidade, uf, banco, agencia, conta, tipo_chave_pix, chave_pix } = req.body;
    try {
        const sql = 'UPDATE clientes SET tipo_pessoa = $1, cnpj_cpf = $2, nome = $3, nome_fantasia = $4, contato = $5, email = $6, telefone = $7, cidade = $8, uf = $9, banco = $10, agencia = $11, conta = $12, tipo_chave_pix = $13, chave_pix = $14 WHERE id = $15';
        await pool.query(sql, [tipo_pessoa, cnpj_cpf ? cnpj_cpf.replace(/\D/g, '') : '', formatarCapitalizacao(nome), formatarCapitalizacao(nome_fantasia), formatarCapitalizacao(contato), email ? email.trim().toLowerCase() : '', telefone, formatarCapitalizacao(cidade), uf ? uf.trim().toUpperCase() : '', formatarCapitalizacao(banco), agencia, conta, tipo_chave_pix, chave_pix, req.params.id]);
        res.redirect('/clientes?sucesso=Atualizado com sucesso!');
    } catch (err) {
        res.redirect('/clientes?erro=Erro ao atualizar.');
    }
});

app.post('/clientes/excluir/:id', verificarAutenticacao, async (req, res) =>