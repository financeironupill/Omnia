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

// CLIENTES
app.get('/clientes', verificarAutenticacao, async (req, res) => {
    try {
        const { busca, ordenar, ordem, origem } = req.query;
        let col = ordenar === 'cnpj_cpf' ? 'cnpj_cpf' : (ordenar === 'nome' ? 'nome' : 'id');
        let dir = ordem === 'ASC' ? 'ASC' : 'DESC';
        let query = 'SELECT c.*, g.nome_resumido AS gerente_nome, v.nome_resumido AS vendedor_nome FROM clientes c LEFT JOIN gerentes g ON c.gerente_id = g.id LEFT JOIN vendedores v ON c.vendedor_id = v.id';
        let params = [];
        if (busca && busca.trim() !== '') {
            query += ' WHERE c.nome ILIKE $1 OR c.nome_fantasia ILIKE $1 OR c.cnpj_cpf ILIKE $1';
            params.push('%' + busca.trim() + '%');
        }
        query += ' ORDER BY c.' + col + ' ' + dir;
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
        console.error(err);
        res.status(500).send('Erro interno');
    }
});

app.get('/clientes/novo', verificarAutenticacao, async (req, res) => {
    try {
        const gerentes = await pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
        const vendedores = await pool.query('SELECT v.id, v.nome_resumido, v.gerente_id FROM vendedores v WHERE v.ativo = 1 ORDER BY v.nome_resumido ASC');
        res.render('cliente-form', { cliente: null, gerentes: gerentes.rows, vendedores: vendedores.rows });
    } catch (err) {
        res.redirect('/clientes?erro=Erro ao carregar formulário.');
    }
});

app.post('/clientes/novo', verificarAutenticacao, async (req, res) => {
    const { tipo_pessoa, cnpj_cpf, nome, nome_fantasia, contato, email, telefone, cidade, uf, banco, agencia, conta, tipo_chave_pix, chave_pix, gerente_id, vendedor_id } = req.body;
    try {
        const sql = 'INSERT INTO clientes (tipo_pessoa, cnpj_cpf, nome, nome_fantasia, contato, email, telefone, cidade, uf, banco, agencia, conta, tipo_chave_pix, chave_pix, gerente_id, vendedor_id, ativo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 1)';
        await pool.query(sql, [
            tipo_pessoa, 
            cnpj_cpf ? cnpj_cpf.replace(/\D/g, '') : '', 
            formatarCapitalizacao(nome), 
            formatarCapitalizacao(nome_fantasia), 
            formatarCapitalizacao(contato), 
            email ? email.trim().toLowerCase() : '', 
            telefone, 
            formatarCapitalizacao(cidade), 
            uf ? uf.trim().toUpperCase() : '', 
            formatarCapitalizacao(banco), 
            agencia, 
            conta, 
            tipo_chave_pix, 
            chave_pix,
            gerente_id ? parseInt(gerente_id, 10) : null,
            vendedor_id ? parseInt(vendedor_id, 10) : null
        ]);
        res.redirect('/clientes?sucesso=Cadastrado com sucesso!');
    } catch (err) {
        console.error(err);
        res.redirect('/clientes?erro=Erro ao cadastrar.');
    }
});

app.get('/clientes/editar/:id', verificarAutenticacao, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.redirect('/clientes?erro=Não encontrado.');
        const gerentes = await pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
        const vendedores = await pool.query('SELECT v.id, v.nome_resumido, v.gerente_id FROM vendedores v WHERE v.ativo = 1 ORDER BY v.nome_resumido ASC');
        res.render('cliente-form', { cliente: result.rows[0], gerentes: gerentes.rows, vendedores: vendedores.rows });
    } catch (err) {
        res.redirect('/clientes?erro=Erro ao carregar.');
    }
});

app.post('/clientes/editar/:id', verificarAutenticacao, async (req, res) => {
    const { tipo_pessoa, cnpj_cpf, nome, nome_fantasia, contato, email, telefone, cidade, uf, banco, agencia, conta, tipo_chave_pix, chave_pix, gerente_id, vendedor_id } = req.body;
    try {
        const sql = 'UPDATE clientes SET tipo_pessoa = $1, cnpj_cpf = $2, nome = $3, nome_fantasia = $4, contato = $5, email = $6, telefone = $7, cidade = $8, uf = $9, banco = $10, agencia = $11, conta = $12, tipo_chave_pix = $13, chave_pix = $14, gerente_id = $15, vendedor_id = $16 WHERE id = $17';
        await pool.query(sql, [
            tipo_pessoa, 
            cnpj_cpf ? cnpj_cpf.replace(/\D/g, '') : '', 
            formatarCapitalizacao(nome), 
            formatarCapitalizacao(nome_fantasia), 
            formatarCapitalizacao(contato), 
            email ? email.trim().toLowerCase() : '', 
            telefone, 
            formatarCapitalizacao(cidade), 
            uf ? uf.trim().toUpperCase() : '', 
            formatarCapitalizacao(banco), 
            agencia, 
            conta, 
            tipo_chave_pix, 
            chave_pix,
            gerente_id ? parseInt(gerente_id, 10) : null,
            vendedor_id ? parseInt(vendedor_id, 10) : null,
            req.params.id
        ]);
        res.redirect('/clientes?sucesso=Atualizado com sucesso!');
    } catch (err) {
        console.error(err);
        res.redirect('/clientes?erro=Erro ao atualizar.');
    }
});

app.post('/clientes/excluir/:id', verificarAutenticacao, async (req, res) => {
    try {
        await pool.query('DELETE FROM clientes WHERE id = $1', [req.params.id]);
        res.redirect('/clientes?sucesso=Excluído!');
    } catch (err) {
        res.redirect('/clientes?erro=Erro ao excluir.');
    }
});

// GERENTES
app.get('/gerentes', verificarAutenticacao, async (req, res) => {
    try {
        const { busca, ordenar, ordem, status } = req.query;
        let col = ordenar === 'nome_completo' ? 'nome_completo' : 'nome_resumido';
        let dir = ordem === 'DESC' ? 'DESC' : 'ASC';
        let statusFiltro = status !== undefined ? status : '1';

        let query = 'SELECT * FROM gerentes WHERE 1=1';
        let params = [];
        let idx = 1;

        if (busca && busca.trim() !== '') {
            query += ' AND (nome_resumido ILIKE $' + idx + ' OR nome_completo ILIKE $' + idx + ')';
            params.push('%' + busca.trim() + '%');
            idx++;
        }

        if (statusFiltro !== '') {
            query += ' AND ativo = $' + idx;
            params.push(parseInt(statusFiltro, 10));
            idx++;
        }

        query += ' ORDER BY ' + col + ' ' + dir;

        const result = await pool.query(query, params);
        res.render('gerentes-lista', { 
            gerentes: result.rows, 
            buscaAtual: busca || '', 
            ordenarAtual: col, 
            ordemAtual: dir, 
            statusAtual: statusFiltro,
            erro: null, 
            sucesso: null 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Erro interno');
    }
});

app.get('/gerentes/relatorio-vendedores/:id', verificarAutenticacao, async (req, res) => {
    try {
        const gerenteId = req.params.id;
        const gerenteRes = await pool.query('SELECT * FROM gerentes WHERE id = $1', [gerenteId]);
        if (gerenteRes.rows.length === 0) {
            return res.redirect('/gerentes?erro=Gerente não encontrado.');
        }
        const vendedoresRes = await pool.query(
            'SELECT * FROM vendedores WHERE gerente_id = $1 ORDER BY nome_resumido ASC', 
            [gerenteId]
        );
        res.render('gerente-relatorio-vendedores', {
            gerente: gerenteRes.rows[0],
            vendedores: vendedoresRes.rows,
            erro: null,
            sucesso: null
        });
    } catch (err) {
        console.error(err);
        res.redirect('/gerentes?erro=Erro ao gerar relatório de vendedores.');
    }
});

app.get('/gerentes/novo', verificarAutenticacao, (req, res) => {
    res.render('gerente-form', { gerente: null, erro: null });
});

app.post('/gerentes/novo', verificarAutenticacao, async (req, res) => {
    const { nome_resumido, nome_completo, telefone, email, banco, agencia, conta, tipo_chave_pix, chave_pix, ativo } = req.body;
    try {
        const sql = 'INSERT INTO gerentes (nome_resumido, nome_completo, telefone, email, banco, agencia, conta, tipo_chave_pix, chave_pix, ativo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)';
        await pool.query(sql, [
            nome_resumido ? nome_resumido.trim().toUpperCase() : '',
            formatarCapitalizacao(nome_completo),
            telefone,
            email ? email.trim().toLowerCase() : '',
            formatarCapitalizacao(banco),
            agencia,
            conta,
            tipo_chave_pix,
            chave_pix,
            ativo ? parseInt(ativo, 10) : 1
        ]);
        res.redirect('/gerentes?sucesso=Gerente cadastrado com sucesso!');
    } catch (err) {
        res.redirect('/gerentes?erro=Erro ao cadastrar.');
    }
});

app.get('/gerentes/editar/:id', verificarAutenticacao, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM gerentes WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.redirect('/gerentes?erro=Não encontrado.');
        res.render('gerente-form', { gerente: result.rows[0], erro: null });
    } catch (err) {
        res.redirect('/gerentes?erro=Erro ao carregar.');
    }
});

app.post('/gerentes/editar/:id', verificarAutenticacao, async (req, res) => {
    const { nome_resumido, nome_completo, telefone, email, banco, agencia, conta, tipo_chave_pix, chave_pix, ativo } = req.body;
    try {
        const sql = 'UPDATE gerentes SET nome_resumido = $1, nome_completo = $2, telefone = $3, email = $4, banco = $5, agencia = $6, conta = $7, tipo_chave_pix = $8, chave_pix = $9, ativo = $10 WHERE id = $11';
        await pool.query(sql, [
            nome_resumido ? nome_resumido.trim().toUpperCase() : '',
            formatarCapitalizacao(nome_completo),
            telefone,
            email ? email.trim().toLowerCase() : '',
            formatarCapitalizacao(banco),
            agencia,
            conta,
            tipo_chave_pix,
            chave_pix,
            ativo ? parseInt(ativo, 10) : 1,
            req.params.id
        ]);
        res.redirect('/gerentes?sucesso=Gerente atualizado com sucesso!');
    } catch (err) {
        res.redirect('/gerentes?erro=Erro ao atualizar.');
    }
});

app.post('/gerentes/excluir/:id', verificarAutenticacao, async (req, res) => {
    try {
        await pool.query('DELETE FROM gerentes WHERE id = $1', [req.params.id]);
        res.redirect('/gerentes?sucesso=Gerente excluído!');
    } catch (err) {
        res.redirect('/gerentes?erro=Erro ao excluir.');
    }
});

// VENDEDORES
app.get('/vendedores', verificarAutenticacao, async (req, res) => {
    try {
        const { busca, ordenar, ordem, status } = req.query;
        let col = ordenar === 'nome_completo' ? 'v.nome_completo' : (ordenar === 'gerente' ? 'g.nome_resumido' : 'v.nome_resumido');
        let dir = ordem === 'DESC' ? 'DESC' : 'ASC';
        let statusFiltro = status !== undefined ? status : '1';

        let query = 'SELECT v.*, g.nome_resumido AS gerente_nome FROM vendedores v LEFT JOIN gerentes g ON v.gerente_id = g.id WHERE 1=1';
        let params = [];
        let idx = 1;

        if (busca && busca.trim() !== '') {
            query += ' AND (v.nome_resumido ILIKE $' + idx + ' OR v.nome_completo ILIKE $' + idx + ' OR g.nome_resumido ILIKE $' + idx + ')';
            params.push('%' + busca.trim() + '%');
            idx++;
        }

        if (statusFiltro !== '') {
            query += ' AND v.ativo = $' + idx;
            params.push(parseInt(statusFiltro, 10));
            idx++;
        }

        query += ' ORDER BY ' + col + ' ' + dir;

        const result = await pool.query(query, params);
        res.render('vendedores-lista', { 
            vendedores: result.rows, 
            buscaAtual: busca || '', 
            ordenarAtual: ordenar || 'nome_resumido', 
            ordemAtual: dir, 
            statusAtual: statusFiltro,
            erro: null, 
            sucesso: null 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Erro interno');
    }
});

app.get('/vendedores/novo', verificarAutenticacao, async (req, res) => {
    try {
        const gerentes = await pool.query('SELECT id, nome_resumido, nome_completo FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
        res.render('vendedor-form', { vendedor: null, gerentes: gerentes.rows, erro: null });
    } catch (err) {
        res.redirect('/vendedores?erro=Erro ao carregar.');
    }
});

app.post('/vendedores/novo', verificarAutenticacao, async (req, res) => {
    const { gerente_id, nome_resumido, nome_completo, telefone, email, banco, agencia, conta, tipo_chave_pix, chave_pix, ativo } = req.body;
    try {
        const sql = 'INSERT INTO vendedores (gerente_id, nome_resumido, nome_completo, telefone, email, banco, agencia, conta, tipo_chave_pix, chave_pix, ativo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)';
        await pool.query(sql, [
            gerente_id ? parseInt(gerente_id, 10) : null,
            nome_resumido ? nome_resumido.trim().toUpperCase() : '',
            formatarCapitalizacao(nome_completo),
            telefone,
            email ? email.trim().toLowerCase() : '',
            formatarCapitalizacao(banco),
            agencia,
            conta,
            tipo_chave_pix,
            chave_pix,
            ativo ? parseInt(ativo, 10) : 1
        ]);
        res.redirect('/vendedores?sucesso=Vendedor cadastrado com sucesso!');
    } catch (err) {
        res.redirect('/vendedores?erro=Erro ao cadastrar.');
    }
});

app.get('/vendedores/editar/:id', verificarAutenticacao, async (req, res) => {
    try {
        const vendedorRes = await pool.query('SELECT * FROM vendedores WHERE id = $1', [req.params.id]);
        if (vendedorRes.rows.length === 0) return res.redirect('/vendedores?erro=Não encontrado.');
        const gerentes = await pool.query('SELECT id, nome_resumido, nome_completo FROM gerentes ORDER BY nome_resumido ASC');
        res.render('vendedor-form', { vendedor: vendedorRes.rows[0], gerentes: gerentes.rows, erro: null });
    } catch (err) {
        res.redirect('/vendedores?erro=Erro ao carregar.');
    }
});

app.post('/vendedores/editar/:id', verificarAutenticacao, async (req, res) => {
    const { gerente_id, nome_resumido, nome_completo, telefone, email, banco, agencia, conta, tipo_chave_pix, chave_pix, ativo } = req.body;
    try {
        const sql = 'UPDATE vendedores SET gerente_id = $1, nome_resumido = $2, nome_completo = $3, telefone = $4, email = $5, banco = $6, agencia = $7, conta = $8, tipo_chave_pix = $9, chave_pix = $10, ativo = $11 WHERE id = $12';
        await pool.query(sql, [
            gerente_id ? parseInt(gerente_id, 10) : null,
            nome_resumido ? nome_resumido.trim().toUpperCase() : '',
            formatarCapitalizacao(nome_completo),
            telefone,
            email ? email.trim().toLowerCase() : '',
            formatarCapitalizacao(banco),
            agencia,
            conta,
            tipo_chave_pix,
            chave_pix,
            ativo ? parseInt(ativo, 10) : 1,
            req.params.id
        ]);
        res.redirect('/vendedores?sucesso=Vendedor atualizado com sucesso!');
    } catch (err) {
        res.redirect('/vendedores?erro=Erro ao atualizar.');
    }
});

app.post('/vendedores/excluir/:id', verificarAutenticacao, async (req, res) => {
    try {
        await pool.query('DELETE FROM vendedores WHERE id = $1', [req.params.id]);
        res.redirect('/vendedores?sucesso=Vendedor excluído!');
    } catch (err) {
        res.redirect('/vendedores?erro=Erro ao excluir.');
    }
});

// OCORRÊNCIAS
app.get('/ocorrencias', verificarAutenticacao, async (req, res) => {
    try {
        const { busca, tipo_id, cliente_nome_busca, transportadora_nome_busca, status, ordenar, ordem } = req.query;
        let queryText = 'SELECT o.*, t.descricao AS tipo_descricao, tr.nome AS transportadora_nome, u.nome AS usuario_nome FROM ocorrencias o LEFT JOIN tipos_ocorrencia t ON o.tipo_ocorrencia_id = t.id LEFT JOIN transportadoras tr ON o.transportadora_id = tr.id LEFT JOIN usuarios u ON o.usuario_id = u.id WHERE 1=1';
        let queryParams = [];
        let idx = 1;

        if (busca && busca.trim() !== '') {
            queryText += ' AND (o.numero ILIKE $' + idx + ' OR o.nf_origem ILIKE $' + idx + ' OR o.nfd ILIKE $' + idx + ' OR o.cliente_nome ILIKE $' + idx + ' OR tr.nome ILIKE $' + idx + ')';
            queryParams.push('%' + busca.trim() + '%');
            idx++;
        }
        if (tipo_id) { 
            queryText += ' AND o.tipo_ocorrencia_id = $' + idx; 
            queryParams.push(parseInt(tipo_id, 10)); 
            idx++; 
        }

        let clienteIdFiltro = '';
        if (cliente_nome_busca && cliente_nome_busca.trim() !== '') {
            const cliRes = await pool.query('SELECT id FROM clientes WHERE UPPER(TRIM(nome)) = UPPER(TRIM($1))', [cliente_nome_busca]);
            if (cliRes.rows.length > 0) {
                clienteIdFiltro = cliRes.rows[0].id;
                queryText += ' AND o.cliente_id = $' + idx;
                queryParams.push(clienteIdFiltro);
                idx++;
            } else {
                queryText += ' AND 1 = 0'; 
            }
        }

        let transportadoraIdFiltro = '';
        if (transportadora_nome_busca && transportadora_nome_busca.trim() !== '') {
            const transpRes = await pool.query('SELECT id FROM transportadoras WHERE UPPER(TRIM(nome)) = UPPER(TRIM($1))', [transportadora_nome_busca]);
            if (transpRes.rows.length > 0) {
                transportadoraIdFiltro = transpRes.rows[0].id;
                queryText += ' AND o.transportadora_id = $' + idx;
                queryParams.push(transportadoraIdFiltro);
                idx++;
            } else {
                queryText += ' AND 1 = 0'; 
            }
        }

        let statusFiltro = status !== undefined ? status : 'Em Aberto';
        if (statusFiltro && statusFiltro !== '') {
            queryText += ' AND o.status = $' + idx; 
            queryParams.push(statusFiltro); 
            idx++; 
        }

        let col = 'o.id';
        if (ordenar === 'tipo') col = 't.descricao';
        if (ordenar === 'cliente') col = 'o.cliente_nome';
        if (ordenar === 'nf') col = 'o.nf_origem';
        if (ordenar === 'status') col = 'o.status';

        let dir = ordem === 'ASC' ? 'ASC' : 'DESC';
        queryText += ' ORDER BY ' + col + ' ' + dir;

        const result = await pool.query(queryText, queryParams);
        const tipos = await pool.query('SELECT id, descricao FROM tipos_ocorrencia ORDER BY descricao ASC');
        const clientes = await pool.query('SELECT id, nome FROM clientes ORDER BY nome ASC');
        const transportadoras = await pool.query('SELECT id, nome FROM transportadoras ORDER BY nome ASC');

        res.render('ocorrencias-lista', { 
            ocorrencias: result.rows, tipos: tipos.rows, clientes: clientes.rows, transportadoras: transportadoras.rows,
            buscaAtual: busca || '', tipoAtual: tipo_id || '', clienteAtual: clienteIdFiltro, 
            transportadoraAtual: transportadoraIdFiltro, statusAtual: statusFiltro, 
            ordenarAtual: ordenar || 'id', ordemAtual: dir, erro: null, sucesso: null 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Erro interno');
    }
});

app.get('/ocorrencias/nova', verificarAutenticacao, async (req, res) => {
    try {
        const tipos = await pool.query('SELECT id, descricao FROM tipos_ocorrencia ORDER BY descricao ASC');
        const clientes = await pool.query('SELECT id, nome FROM clientes ORDER BY nome ASC');
        const transportadoras = await pool.query('SELECT id, nome FROM transportadoras ORDER BY nome ASC');
        res.render('ocorrencia-form', { ocorrencia: null, tipos: tipos.rows, clientes: clientes.rows, transportadoras: transportadoras.rows, numeroSugerido: gerarNumeroOcorrencia() });
    } catch (err) {
        res.redirect('/ocorrencias?erro=Erro ao carregar.');
    }
});

app.post('/ocorrencias/novo', verificarAutenticacao, async (req, res) => {
    const { tipo_ocorrencia_id, cliente_id, transportadora_id, nf_origem, valor_nf_origem, vencimento_atual, nfd, tipo_financeiro, valor_financeiro, descricao_problema } = req.body;
    try {
        const cli = await pool.query('SELECT nome FROM clientes WHERE id = $1', [cliente_id]);
        const cliNome = cli.rows.length > 0 ? cli.rows[0].nome : '';
        const sql = 'INSERT INTO ocorrencias (numero, tipo_ocorrencia_id, cliente_id, transportadora_id, usuario_id, cliente_nome, nf_origem, valor_nf_origem, vencimento_atual, nfd, tipo_financeiro, valor_financeiro, descricao_problema, status, criado_em, atualizado_em) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, \'Em Aberto\', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)';
        await pool.query(sql, [gerarNumeroOcorrencia(), parseInt(tipo_ocorrencia_id, 10), parseInt(cliente_id, 10), transportadora_id ? parseInt(transportadora_id, 10) : null, req.session.usuario.id, cliNome, nf_origem ? nf_origem.trim().toUpperCase() : '', valor_nf_origem ? parseFloat(valor_nf_origem) : null, vencimento_atual || null, nfd ? nfd.trim().toUpperCase() : '', tipo_financeiro || null, valor_financeiro ? parseFloat(valor_financeiro) : null, formatarCapitalizacao(descricao_problema)]);
        res.redirect('/ocorrencias?sucesso=Ocorrência registrada!');
    } catch (err) {
        console.error(err);
        res.redirect('/ocorrencias?erro=Erro ao registrar.');
    }
});

app.get('/ocorrencias/detalhes/:id', verificarAutenticacao, async (req, res) => {
    try {
        const sql = 'SELECT o.*, t.descricao AS tipo_descricao, tr.nome AS transportadora_nome, c.nome AS cliente_nome_real, u.nome AS usuario_nome FROM ocorrencias o LEFT JOIN tipos_ocorrencia t ON o.tipo_ocorrencia_id = t.id LEFT JOIN transportadoras tr ON o.transportadora_id = tr.id LEFT JOIN clientes c ON o.cliente_id = c.id LEFT JOIN usuarios u ON o.usuario_id = u.id WHERE o.id = $1';
        const result = await pool.query(sql, [req.params.id]);
        if (result.rows.length === 0) return res.redirect('/ocorrencias?erro=Não encontrada.');
        res.render('ocorrencia-detalhes', { ocorrencia: result.rows[0], erro: null, sucesso: null });
    } catch (err) {
        res.redirect('/ocorrencias?erro=Erro.');
    }
});

app.get('/ocorrencias/editar/:id', verificarAutenticacao, async (req, res) => {
    try {
        const edit = await pool.query('SELECT * FROM ocorrencias WHERE id = $1', [req.params.id]);
        if (edit.rows.length === 0) return res.redirect('/ocorrencias?erro=Não encontrada.');
        const tipos = await pool.query('SELECT id, descricao FROM tipos_ocorrencia ORDER BY descricao ASC');
        const clientes = await pool.query('SELECT id, nome FROM clientes ORDER BY nome ASC');
        const transportadoras = await pool.query('SELECT id, nome FROM transportadoras ORDER BY nome ASC');
        res.render('ocorrencia-form', { ocorrencia: edit.rows[0], tipos: tipos.rows, clientes: clientes.rows, transportadoras: transportadoras.rows, numeroSugerido: edit.rows[0].numero });
    } catch (err) {
        res.redirect('/ocorrencias?erro=Erro.');
    }
});

app.post('/ocorrencias/editar/:id', verificarAutenticacao, async (req, res) => {
    const { tipo_ocorrencia_id, cliente_id, transportadora_id, nf_origem, valor_nf_origem, vencimento_atual, nfd, tipo_financeiro, valor_financeiro, status, descricao_problema, solucao_aplicada } = req.body;
    try {
        const cli = await pool.query('SELECT nome FROM clientes WHERE id = $1', [cliente_id]);
        const cliNome = cli.rows.length > 0 ? cli.rows[0].nome : '';
        const sql = 'UPDATE ocorrencias SET tipo_ocorrencia_id = $1, cliente_id = $2, transportadora_id = $3, cliente_nome = $4, nf_origem = $5, valor_nf_origem = $6, vencimento_atual = $7, nfd = $8, tipo_financeiro = $9, valor_financeiro = $10, status = $11, descricao_problema = $12, solucao_aplicada = $13, atualizado_em = CURRENT_TIMESTAMP WHERE id = $14';
        await pool.query(sql, [parseInt(tipo_ocorrencia_id, 10), parseInt(cliente_id, 10), transportadora_id ? parseInt(transportadora_id, 10) : null, cliNome, nf_origem ? nf_origem.trim().toUpperCase() : '', valor_nf_origem ? parseFloat(valor_nf_origem) : null, vencimento_atual || null, nfd ? nfd.trim().toUpperCase() : '', tipo_financeiro || null, valor_financeiro ? parseFloat(valor_financeiro) : null, status, formatarCapitalizacao(descricao_problema), formatarCapitalizacao(solucao_aplicada), req.params.id]);
        res.redirect('/ocorrencias?sucesso=Atualizada com sucesso!');
    } catch (err) {
        console.error(err);
        res.redirect('/ocorrencias?erro=Erro ao atualizar.');
    }
});

app.post('/ocorrencias/excluir/:id', verificarAutenticacao, async (req, res) => {
    try {
        await pool.query('DELETE FROM ocorrencias WHERE id = $1', [req.params.id]);
        res.redirect('/ocorrencias?sucesso=Excluída!');
    } catch (err) {
        res.redirect('/ocorrencias?erro=Erro ao excluir.');
    }
});

// OMNIA COBRANÇA (Com filtros de Gerente e Vendedor)
app.get('/cobranca', verificarAutenticacao, async (req, res) => {
    try {
        const { busca, status, gerente_id, vendedor_id } = req.query;
        let queryText = `
            SELECT c.*, cl.nome AS cliente_nome, cl.cnpj_cpf AS cliente_cnpj, 
                   g.nome_resumido AS gerente_nome, v.nome_resumido AS vendedor_nome 
            FROM contas_receber c 
            LEFT JOIN clientes cl ON c.cliente_id = cl.id 
            LEFT JOIN gerentes g ON c.gerente_id = g.id 
            LEFT JOIN vendedores v ON c.vendedor_id = v.id 
            WHERE 1=1
        `;
        let queryParams = [];
        let idx = 1;

        if (busca && busca.trim() !== '') {
            queryText += ' AND (c.numero_documento ILIKE $' + idx + ' OR cl.nome ILIKE $' + idx + ' OR c.banco ILIKE $' + idx + ')';
            queryParams.push('%' + busca.trim() + '%');
            idx++;
        }

        let statusFiltro = status !== undefined ? status : 'Em Aberto';
        if (statusFiltro && statusFiltro !== '') {
            queryText += ' AND c.status = $' + idx;
            queryParams.push(statusFiltro);
            idx++;
        }

        if (gerente_id && gerente_id !== '') {
            queryText += ' AND c.gerente_id = $' + idx;
            queryParams.push(parseInt(gerente_id, 10));
            idx++;
        }

        if (vendedor_id && vendedor_id !== '') {
            queryText += ' AND c.vendedor_id = $' + idx;
            queryParams.push(parseInt(vendedor_id, 10));
            idx++;
        }

        queryText += ' ORDER BY c.data_vencimento ASC';

        const result = await pool.query(queryText, queryParams);
        const gerentes = await pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
        const vendedores = await pool.query('SELECT id, nome_resumido FROM vendedores WHERE ativo = 1 ORDER BY nome_resumido ASC');
        
        const hoje = new Date();
        result.rows.forEach(c => {
            let dataFim = hoje;
            if ((c.status_boleto === 'Custas' || c.status_boleto === 'Pago') && c.data_pagamento) {
                dataFim = new Date(c.data_pagamento);
            }
            if (c.data_vencimento) {
                const diffTime = dataFim - new Date(c.data_vencimento);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                c.dias_vencidos_calc = diffDays > 0 ? diffDays : 0;
            } else {
                c.dias_vencidos_calc = 0;
            }
        });

        res.render('cobranca-lista', { 
            contas: result.rows, 
            gerentes: gerentes.rows,
            vendedores: vendedores.rows,
            buscaAtual: busca || '', 
            statusAtual: statusFiltro, 
            gerenteAtual: gerente_id || '',
            vendedorAtual: vendedor_id || '',
            erro: null, 
            sucesso: null 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Erro interno');
    }
});

app.get('/cobranca/nova', verificarAutenticacao, async (req, res) => {
    try {
        // Busca clientes junto com seus gerentes e vendedores para preenchimento automático
        const clientes = await pool.query(`
            SELECT c.id, c.nome, c.gerente_id, c.vendedor_id, 
                   g.nome_resumido AS gerente_nome, v.nome_resumido AS vendedor_nome 
            FROM clientes c 
            LEFT JOIN gerentes g ON c.gerente_id = g.id 
            LEFT JOIN vendedores v ON c.vendedor_id = v.id 
            WHERE c.ativo = 1 
            ORDER BY c.nome ASC
        `);
        res.render('cobranca-form', { conta: null, clientes: clientes.rows, erro: null, sucesso: null });
    } catch (err) {
        console.error(err);
        res.redirect('/cobranca?erro=Erro ao carregar formulário.');
    }
});

app.post('/cobranca/novo', verificarAutenticacao, async (req, res) => {
    const { 
        cliente_id, numero_documento, banco, valor_original, data_emissao, data_vencimento, 
        tipo_cobranca, observacoes, status_boleto, data_pagamento, status_cobranca, 
        valor_custas, carteira, debito_conta_corrente, cadastro_tipo, data_cartorio, 
        comissao, data_estorno, data_reposicao 
    } = req.body;

    try {
        // Busca automática do gerente e vendedor associados ao cliente para gravar na cobrança
        const cliRes = await pool.query('SELECT gerente_id, vendedor_id FROM clientes WHERE id = $1', [cliente_id]);
        let gerenteId = null;
        let vendedorId = null;
        if (cliRes.rows.length > 0) {
            gerenteId = cliRes.rows[0].gerente_id;
            vendedorId = cliRes.rows[0].vendedor_id;
        }

        let diasVencidos = 0;
        const dataVenc = new Date(data_vencimento);
        let dataFim = new Date();

        if ((status_boleto === 'Custas' || status_boleto === 'Pago') && data_pagamento) {
            dataFim = new Date(data_pagamento);
        }

        if (dataVenc && dataFim) {
            const diffTime = dataFim - dataVenc;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            diasVencidos = diffDays > 0 ? diffDays : 0;
        }

        const sql = `INSERT INTO contas_receber (
            cliente_id, gerente_id, vendedor_id, numero_documento, banco, valor_original, valor_recebido, data_emissao, 
            data_vencimento, status, tipo_cobranca, observacoes, status_boleto, data_pagamento, 
            dias_vencidos, status_cobranca, valor_custas, carteira, debito_conta_corrente, 
            cadastro_tipo, data_cartorio, comissao, data_estorno, data_reposicao, criado_em, atualizado_em
        ) VALUES ($1, $2, $3, $4, $5, $6, 0.00, $7, $8, 'Em Aberto', $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;

        await pool.query(sql, [
            parseInt(cliente_id, 10),
            gerenteId,
            vendedorId,
            numero_documento ? numero_documento.trim().toUpperCase() : '',
            banco,
            parseFloat(valor_original) || 0,
            data_emissao,
            data_vencimento,
            tipo_cobranca,
            formatarCapitalizacao(observacoes),
            status_boleto || 'Vencido',
            data_pagamento || null,
            diasVencidos,
            status_cobranca || 'Iniciar',
            parseFloat(valor_custas) || 0.00,
            carteira || 'Simples',
            debito_conta_corrente || null,
            cadastro_tipo || 'Normal',
            data_cartorio || null,
            comissao || 'Não Estornada',
            data_estorno || null,
            data_reposicao || null
        ]);

        res.redirect('/cobranca?sucesso=Cobrança cadastrada com sucesso!');
    } catch (err) {
        console.error(err);
        res.redirect('/cobranca?erro=Erro ao cadastrar cobrança.');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/', (req, res) => {
    if (req.session.usuario) {
        return res.redirect('/dashboard');
    }
    res.redirect('/login');
});

app.listen(PORT, () => {
    console.log(`Servidor Omnia a correr na porta ${PORT}`);
});