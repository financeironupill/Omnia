const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const https = require('https');
const pool = require('./db');
const { sincronizarPendenciasRegua } = require('./servicos/cobrancaService');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);
if (!process.env.SESSION_SECRET) {
    throw new Error('A variável SESSION_SECRET deve ser configurada no ambiente.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Servir arquivos estáticos (CSS, JS, imagens) da pasta public
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
}));

function formatarCapitalizacao(texto) {
    if (!texto) return '';
    return texto.trim().toLowerCase().split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function formatarCnpjCpf(valor) {
    if (!valor) return '';
    const limpo = String(valor).replace(/\D/g, '');
    if (limpo.length === 14) {
        return limpo.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    } else if (limpo.length === 11) {
        return limpo.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
    }
    return valor;
}

function validarIdentificacaoVendedor({ cpf, cnpj, razao_social }) {
    if ([cpf, cnpj, razao_social].some(valor => valor !== undefined && typeof valor !== 'string')) {
        return { erro: 'Dados de identificação inválidos.' };
    }

    const cpfLimpo = (cpf || '').replace(/\D/g, '');
    const cnpjLimpo = (cnpj || '').replace(/\D/g, '');
    const cpfInformado = Boolean(cpf && cpf.trim());
    const cnpjInformado = Boolean(cnpj && cnpj.trim());
    const razaoSocial = (razao_social || '').trim();

    if (cpfInformado && cpfLimpo.length !== 11) {
        return { erro: 'CPF deve conter 11 dígitos.' };
    }
    if (cnpjInformado && cnpjLimpo.length !== 14) {
        return { erro: 'CNPJ deve conter 14 dígitos.' };
    }
    if (cnpjInformado && !razaoSocial) {
        return { erro: 'Razão Social é obrigatória quando um CNPJ é informado.' };
    }

    return {
        cpf: cpfInformado ? cpfLimpo : null,
        cnpj: cnpjInformado ? cnpjLimpo : null,
        razaoSocial: razaoSocial || null
    };
}

function formatarMoedaSemSimbolo(valor) {
    const num = parseFloat(valor) || 0;
    return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function gerarNumeroOcorrencia() {
    const a = new Date();
    return `${a.getFullYear()}${String(a.getMonth() + 1).padStart(2, '0')}${Math.floor(1000 + Math.random() * 9000)}`;
}

function limparValorMonetario(valor) {
    if (valor === null || valor === undefined) return 0;
    if (typeof valor === 'number') return valor;
    let limpo = String(valor).replace(/\./g, '').replace(',', '.');
    return parseFloat(limpo) || 0;
}

function validarValorMonetario(valor, { permitirZero = false } = {}) {
    if (typeof valor === 'number') {
        return Number.isFinite(valor) && (permitirZero ? valor >= 0 : valor > 0);
    }
    if (typeof valor !== 'string') return false;
    const texto = valor.trim();
    const formatoBrasileiro = /^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/;
    if (!formatoBrasileiro.test(texto)) return false;
    const numero = Number(texto.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(numero) && (permitirZero ? numero >= 0 : numero > 0);
}

function validarDataOpcional(valor) {
    if (valor === undefined || valor === null || valor === '') return true;
    if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
    const data = new Date(`${valor}T00:00:00Z`);
    return !Number.isNaN(data.getTime()) && data.toISOString().slice(0, 10) === valor;
}

const situacoesBoletoValidas = ['Vencido', 'Pago', 'Pago com Pendência'];
const fasesCobrancaValidas = [
    'Aguardando Régua',
    'Aviso 1 (Notificação)',
    'Aviso 2 (Alerta Cartório)',
    'Aviso 3 (Aviso Final)',
    'Em Cartório / Negativado',
    'Custas Pendentes (Cartório)',
    'Concluído'
];

function validarDadosBoleto({ valor_original, situacao_boleto, status_cobranca, data_pagamento, valor_custas }) {
    if (!validarValorMonetario(valor_original)) return 'O valor original deve ser maior que zero.';
    if (valor_custas !== undefined && !validarValorMonetario(valor_custas, { permitirZero: true })) {
        return 'O valor das custas não pode ser negativo ou inválido.';
    }
    if (situacao_boleto !== undefined && !situacoesBoletoValidas.includes(situacao_boleto)) {
        return 'A situação do boleto é inválida.';
    }
    if (status_cobranca !== undefined && !fasesCobrancaValidas.includes(status_cobranca)) {
        return 'A fase da régua de cobrança é inválida.';
    }
    if (!validarDataOpcional(data_pagamento)) return 'A data de pagamento é inválida.';
    if (['Pago', 'Pago com Pendência'].includes(situacao_boleto) && !data_pagamento) {
        return 'Informe a data de pagamento para marcar o boleto como pago.';
    }
    return null;
}

function tratarData(dataInput) {
    if (!dataInput) return null;
    if (dataInput instanceof Date) {
        return dataInput.toISOString().split('T')[0];
    }
    const str = String(dataInput).trim();
    if (str === '') return null;
    return str;
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
        console.log(`Login bem-sucedido. ID do utilizador: ${req.session.usuario.id}`);
        req.session.save((err) => {
            if (err) {
                console.error('Erro ao guardar sessão após login:', err);
                return res.status(500).render('login', { erro: 'Erro interno.' });
            }
            res.redirect('/dashboard');
        });
    } catch (e) {
        res.render('login', { erro: 'Erro interno.' });
    }
});

app.get('/dashboard', verificarAutenticacao, (req, res) => res.render('dashboard', { usuario: req.session.usuario, erro: req.query.erro || null }));
app.get('/solucao', verificarAutenticacao, (req, res) => res.render('dashboard-solucao', { usuario: req.session.usuario }));

async function exibirDashboardCobranca(req, res) {
    try {
        const filtrosRecuperacaoValidos = ['ativos', 'todos', 'fundo_perdido'];
        const filtroRecuperacao = typeof req.query.filtro_recuperacao === 'string'
            && filtrosRecuperacaoValidos.includes(req.query.filtro_recuperacao)
            ? req.query.filtro_recuperacao
            : 'ativos';

        await sincronizarPendenciasRegua(pool, req.session.usuario.id);
        const [agingRes, tarefasRes] = await Promise.all([
            pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE CURRENT_DATE - b.data_vencimento BETWEEN 1 AND 15) AS dias_1_15_qtd,
                    COALESCE(SUM(b.valor_original) FILTER (WHERE CURRENT_DATE - b.data_vencimento BETWEEN 1 AND 15), 0) AS dias_1_15_valor,
                    COUNT(*) FILTER (WHERE CURRENT_DATE - b.data_vencimento BETWEEN 16 AND 30) AS dias_16_30_qtd,
                    COALESCE(SUM(b.valor_original) FILTER (WHERE CURRENT_DATE - b.data_vencimento BETWEEN 16 AND 30), 0) AS dias_16_30_valor,
                    COUNT(*) FILTER (WHERE CURRENT_DATE - b.data_vencimento > 30) AS dias_31_mais_qtd,
                    COALESCE(SUM(b.valor_original) FILTER (WHERE CURRENT_DATE - b.data_vencimento > 30), 0) AS dias_31_mais_valor,
                    COUNT(*) FILTER (WHERE b.status_cobranca = 'Em Cartório / Negativado') AS cartorio_qtd,
                    COALESCE(SUM(b.valor_original) FILTER (WHERE b.status_cobranca = 'Em Cartório / Negativado'), 0) AS cartorio_valor
                FROM boletos AS b
                WHERE b.excluido_em IS NULL
                  AND b.situacao_boleto IN ('Vencido', 'Pago com Pendência')
                  AND b.data_vencimento < CURRENT_DATE
                  AND (
                      $1 = 'todos'
                      OR ($1 = 'ativos' AND b.fundo_perdido IS NOT TRUE)
                      OR ($1 = 'fundo_perdido' AND b.fundo_perdido IS TRUE)
                  )
            `, [filtroRecuperacao]),
            pool.query(`
                SELECT pendencia.id AS pendencia_id, pendencia.boleto_id AS id, pendencia.etapa,
                       pendencia.acao, pendencia.data_acao, b.numero_documento, b.data_vencimento,
                       b.valor_original, b.status_cobranca,
                       c.nome AS cliente_nome, c.email AS cliente_email
                FROM boletos_regua_pendencias AS pendencia
                JOIN boletos b ON b.id = pendencia.boleto_id
                JOIN clientes c ON c.id = b.cliente_id
                WHERE pendencia.status = 'Pendente'
                  AND b.excluido_em IS NULL
                  AND b.situacao_boleto IN ('Vencido', 'Pago com Pendência')
                  AND pendencia.fase_origem = b.status_cobranca
                  AND pendencia.data_fase_origem = b.data_fase_cobranca
                  AND (
                      $1 = 'todos'
                      OR ($1 = 'ativos' AND b.fundo_perdido IS NOT TRUE)
                      OR ($1 = 'fundo_perdido' AND b.fundo_perdido IS TRUE)
                  )
                ORDER BY pendencia.data_acao, b.data_vencimento, b.id
            `, [filtroRecuperacao])
        ]);
        const aging = agingRes.rows[0];
        ['dias_1_15_valor', 'dias_16_30_valor', 'dias_31_mais_valor', 'cartorio_valor']
            .forEach(campo => { aging[campo] = formatarMoedaSemSimbolo(aging[campo]); });
        res.render('cobranca-dashboard', {
            usuario: req.session.usuario,
            aging,
            tarefas: tarefasRes.rows,
            filtroRecuperacaoAtual: filtroRecuperacao
        });
    } catch (err) {
        console.error('ERRO AO CARREGAR DASHBOARD DE COBRANÇA:', {
            name: err instanceof Error ? err.name : 'UnknownError',
            message: err instanceof Error ? err.message : String(err),
            code: err && err.code,
            stack: err instanceof Error ? err.stack : undefined
        });
        res.status(500).send('Erro ao carregar o dashboard de cobrança.');
    }
}

app.get('/cobranca/dashboard', verificarAutenticacao, exibirDashboardCobranca);
app.get('/cobranca/hoje-a-fazer', verificarAutenticacao, exibirDashboardCobranca);

// CONSULTA CNPJ COM HTTPS NATIVO
app.get('/api/consultar-cnpj/:cnpj', verificarAutenticacao, (req, res) => {
    const cnpjClean = req.params.cnpj.replace(/\D/g, '');
    if (cnpjClean.length !== 14) {
        return res.status(400).json({ erro: 'CNPJ inválido' });
    }

    const options = {
        hostname: 'brasilapi.com.br',
        path: `/api/cnpj/v1/${cnpjClean}`,
        method: 'GET',
        headers: { 'User-Agent': 'OmniaApp/1.0' }
    };

    const request = https.request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
            if (response.statusCode === 200) {
                try {
                    const parsedData = JSON.parse(data);
                    return res.json(parsedData);
                } catch (e) {
                    return res.status(500).json({ erro: 'Erro ao processar dados do CNPJ' });
                }
            } else {
                return res.status(404).json({ erro: 'CNPJ não encontrado' });
            }
        });
    });

    request.on('error', (error) => {
        console.error('Erro na requisição HTTPS do CNPJ:', error);
        res.status(500).json({ erro: 'Erro de conexão na consulta externa' });
    });

    request.end();
});

// CADASTRAR CLIENTE VIA MODAL (AJAX/API)
app.post('/api/clientes/novo', verificarAutenticacao, async (req, res) => {
    const { tipo_pessoa, cnpj_cpf, nome, nome_fantasia, contato, email, telefone, cidade, uf, gerente_id, vendedor_id } = req.body;
    try {
        const cnpjCpfLimpo = String(cnpj_cpf || '').replace(/\D/g, '');
        if (cnpjCpfLimpo) {
            const clienteExistente = await pool.query(
                `SELECT id FROM clientes
                 WHERE regexp_replace(COALESCE(cnpj_cpf, ''), '[^0-9]', '', 'g') = $1
                 LIMIT 1`,
                [cnpjCpfLimpo]
            );
            if (clienteExistente.rows.length > 0) {
                return res.status(409).json({ sucesso: false, erro: 'Este cliente já está cadastrado.' });
            }
        }

        const sql = `
            INSERT INTO clientes (tipo_pessoa, cnpj_cpf, nome, nome_fantasia, contato, email, telefone, cidade, uf, gerente_id, vendedor_id, ativo) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1) 
            RETURNING id, nome
        `;
        const novoCliRes = await pool.query(sql, [
            tipo_pessoa || 'PJ (CNPJ)', 
            cnpj_cpf ? cnpj_cpf.replace(/\D/g, '') : '', 
            formatarCapitalizacao(nome), 
            formatarCapitalizacao(nome_fantasia), 
            formatarCapitalizacao(contato), 
            email ? email.trim().toLowerCase() : '', 
            telefone, 
            formatarCapitalizacao(cidade), 
            uf ? uf.trim().toUpperCase() : '', 
            gerente_id ? parseInt(gerente_id, 10) : null,
            vendedor_id ? parseInt(vendedor_id, 10) : null
        ]);

        const clienteCadastrado = novoCliRes.rows[0];

        const gRes = gerente_id ? await pool.query('SELECT nome_resumido FROM gerentes WHERE id = $1', [gerente_id]) : { rows: [] };
        const vRes = vendedor_id ? await pool.query('SELECT nome_resumido FROM vendedores WHERE id = $1', [vendedor_id]) : { rows: [] };

        res.json({
            sucesso: true,
            cliente: {
                id: clienteCadastrado.id,
                nome: clienteCadastrado.nome,
                gerente_id: gerente_id || '',
                vendedor_id: vendedor_id || '',
                gerente_nome: gRes.rows.length > 0 ? gRes.rows[0].nome_resumido : '',
                vendedor_nome: vRes.rows.length > 0 ? vRes.rows[0].nome_resumido : ''
            }
        });
    } catch (err) {
        console.error('ERRO API CLIENTE:', err);
        res.status(500).json({ sucesso: false, erro: 'Erro ao cadastrar cliente: ' + err.message });
    }
});

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
            params.push('%' + busca.trim().replace(/\D/g, '') + '%');
        }
        query += ' ORDER BY ' + col + ' ' + dir;
        const result = await pool.query(query, params);

        result.rows.forEach(tr => {
            tr.cnpj = formatarCnpjCpf(tr.cnpj);
        });

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
        if (result.rows.length > 0) {
            result.rows[0].cnpj = formatarCnpjCpf(result.rows[0].cnpj);
        }
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
        const { busca, ordenar, ordem, origem, campo, ord, page } = req.query;
        const colunasOrdenacao = {
            id: 'c.id',
            tipo: 'c.tipo_pessoa',
            cpf_cnpj: 'c.cnpj_cpf',
            nome: 'c.nome, c.nome_fantasia',
            gerente: 'g.nome_resumido, v.nome_resumido',
            cidade_uf: 'c.cidade, c.uf'
        };
        const colunaAtual = Object.prototype.hasOwnProperty.call(colunasOrdenacao, campo)
            ? campo
            : (ord === 'az' || ord === 'za' ? 'nome' : (ordenar === 'cnpj_cpf' ? 'cpf_cnpj' : (ordenar === 'nome' ? 'nome' : 'id')));
        const ordemAtual = ord === 'asc' || ord === 'az'
            ? 'ASC'
            : (ord === 'desc' || ord === 'za' ? 'DESC' : (ordem === 'ASC' ? 'ASC' : 'DESC'));
        const ordAtual = ordemAtual.toLowerCase();
        let query = 'SELECT c.*, g.nome_resumido AS gerente_nome, v.nome_resumido AS vendedor_nome FROM clientes c LEFT JOIN gerentes g ON c.gerente_id = g.id LEFT JOIN vendedores v ON c.vendedor_id = v.id';
        let params = [];
        if (busca && busca.trim() !== '') {
            query += ' WHERE c.nome ILIKE $1 OR c.nome_fantasia ILIKE $1 OR c.cnpj_cpf ILIKE $1';
            params.push('%' + busca.trim() + '%');
        }
        query += ' ORDER BY ' + colunasOrdenacao[colunaAtual].split(', ').map(coluna => `${coluna} ${ordemAtual}`).join(', ');
        const result = await pool.query(query, params);

        result.rows.forEach(cli => {
            cli.cnpj_cpf = formatarCnpjCpf(cli.cnpj_cpf);
        });

        res.render('clientes-lista', { 
            clientes: result.rows, 
            buscaAtual: busca || '', 
            campoAtual: colunaAtual,
            ordenarAtual: colunaAtual,
            ordemAtual,
            ordAtual,
            paginaAtual: typeof page === 'string' ? page : '',
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
        res.render('cliente-form', { cliente: null, gerentes: gerentes.rows, vendedores: vendedores.rows, erro: null });
    } catch (err) {
        res.redirect('/clientes?erro=Erro ao carregar formulário.');
    }
});

app.post('/clientes/novo', verificarAutenticacao, async (req, res) => {
    const { tipo_pessoa, cnpj_cpf, nome, nome_fantasia, contato, email, telefone, cidade, uf, banco, agencia, conta, tipo_chave_pix, chave_pix, gerente_id, vendedor_id } = req.body;
    try {
        const cnpjCpfLimpo = String(cnpj_cpf || '').replace(/\D/g, '');
        if (cnpjCpfLimpo) {
            const clienteExistente = await pool.query(
                `SELECT id FROM clientes
                 WHERE regexp_replace(COALESCE(cnpj_cpf, ''), '[^0-9]', '', 'g') = $1
                 LIMIT 1`,
                [cnpjCpfLimpo]
            );
            if (clienteExistente.rows.length > 0) {
                const gerentes = await pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
                const vendedores = await pool.query('SELECT v.id, v.nome_resumido, v.gerente_id FROM vendedores v WHERE v.ativo = 1 ORDER BY v.nome_resumido ASC');
                return res.status(409).render('cliente-form', {
                    cliente: req.body,
                    gerentes: gerentes.rows,
                    vendedores: vendedores.rows,
                    erro: 'Este cliente já está cadastrado.'
                });
            }
        }

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
        console.error('ERRO AO CADASTRAR CLIENTE:', err);
        const gerentes = await pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
        const vendedores = await pool.query('SELECT v.id, v.nome_resumido, v.gerente_id FROM vendedores v WHERE v.ativo = 1 ORDER BY v.nome_resumido ASC');
        res.render('cliente-form', { 
            cliente: req.body, 
            gerentes: gerentes.rows, 
            vendedores: vendedores.rows, 
            erro: 'Erro ao cadastrar cliente: ' + err.message 
        });
    }
});

app.get('/clientes/editar/:id', verificarAutenticacao, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.redirect('/clientes?erro=Não encontrado.');

        if (result.rows[0].cnpj_cpf) {
            result.rows[0].cnpj_cpf = formatarCnpjCpf(result.rows[0].cnpj_cpf);
        }

        const gerentes = await pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
        const vendedores = await pool.query('SELECT v.id, v.nome_resumido, v.gerente_id FROM vendedores v WHERE v.ativo = 1 ORDER BY v.nome_resumido ASC');
        res.render('cliente-form', { cliente: result.rows[0], gerentes: gerentes.rows, vendedores: vendedores.rows, erro: null });
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

// GERENTES E VENDEDORES
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
            query += ' AND (v.nome_resumido ILIKE $' + idx + ' OR v.nome_completo ILIKE $' + idx + ' OR v.razao_social ILIKE $' + idx + ' OR v.cpf ILIKE $' + idx + ' OR v.cnpj ILIKE $' + idx + ' OR g.nome_resumido ILIKE $' + idx + ')';
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
        result.rows.forEach(v => {
            v.cpf_formatado = formatarCnpjCpf(v.cpf);
            v.cnpj_formatado = formatarCnpjCpf(v.cnpj);
        });
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
    const identificacao = validarIdentificacaoVendedor(req.body);
    if (identificacao.erro) {
        return res.redirect(`/vendedores?erro=${encodeURIComponent(identificacao.erro)}`);
    }

    try {
        const sql = 'INSERT INTO vendedores (gerente_id, nome_resumido, nome_completo, cpf, cnpj, razao_social, telefone, email, banco, agencia, conta, tipo_chave_pix, chave_pix, ativo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)';
        await pool.query(sql, [
            gerente_id ? parseInt(gerente_id, 10) : null,
            nome_resumido ? nome_resumido.trim().toUpperCase() : '',
            formatarCapitalizacao(nome_completo),
            identificacao.cpf,
            identificacao.cnpj,
            identificacao.razaoSocial,
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
        console.error('ERRO AO CADASTRAR VENDEDOR:', err);
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
    const identificacao = validarIdentificacaoVendedor(req.body);
    if (identificacao.erro) {
        return res.redirect(`/vendedores?erro=${encodeURIComponent(identificacao.erro)}`);
    }

    try {
        const sql = 'UPDATE vendedores SET gerente_id = $1, nome_resumido = $2, nome_completo = $3, cpf = $4, cnpj = $5, razao_social = $6, telefone = $7, email = $8, banco = $9, agencia = $10, conta = $11, tipo_chave_pix = $12, chave_pix = $13, ativo = $14 WHERE id = $15';
        await pool.query(sql, [
            gerente_id ? parseInt(gerente_id, 10) : null,
            nome_resumido ? nome_resumido.trim().toUpperCase() : '',
            formatarCapitalizacao(nome_completo),
            identificacao.cpf,
            identificacao.cnpj,
            identificacao.razaoSocial,
            telefone,
            email ? email.trim().toLowerCase() : '',
            banco,
            agencia,
            conta,
            tipo_chave_pix,
            chave_pix,
            ativo ? parseInt(ativo, 10) : 1,
            req.params.id
        ]);
        res.redirect('/vendedores?sucesso=Vendedor atualizado com sucesso!');
    } catch (err) {
        console.error('ERRO AO ATUALIZAR VENDEDOR:', err);
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
        await pool.query(sql, [gerarNumeroOcorrencia(), parseInt(tipo_ocorrencia_id, 10), parseInt(cliente_id, 10), transportadora_id ? parseInt(transportadora_id, 10) : null, req.session.usuario.id, cliNome, nf_origem ? nf_origem.trim().toUpperCase() : '', limparValorMonetario(valor_nf_origem), tratarData(vencimento_atual), nfd ? nfd.trim().toUpperCase() : '', tipo_financeiro || null, limparValorMonetario(valor_financeiro), formatarCapitalizacao(descricao_problema)]);
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
        await pool.query(sql, [parseInt(tipo_ocorrencia_id, 10), parseInt(cliente_id, 10), transportadora_id ? parseInt(transportadora_id, 10) : null, cliNome, limparValorMonetario(valor_nf_origem), tratarData(vencimento_atual), nfd ? nfd.trim().toUpperCase() : '', tipo_financeiro || null, limparValorMonetario(valor_financeiro), status, formatarCapitalizacao(descricao_problema), formatarCapitalizacao(solucao_aplicada), req.params.id]);
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

// MÓDULO DE BOLETOS E RÉGUA DE COBRANÇA
function criarQueryFiltrosCobranca(query) {
    const filtrosPadrao = {
        busca: '',
        status_boleto: 'pendentes',
        banco: '',
        status_cobranca: '',
        gerente_id: '',
        vendedor_id: '',
        data_vencimento_de: '',
        data_vencimento_ate: '',
        exibir_atualizado: '',
        data_atualizado_de: '',
        data_atualizado_ate: '',
        exibir_fundo_perdido: 'ativos',
        ordenar: '',
        ordem: ''
    };
    const params = new URLSearchParams();

    filtrosPadrao.data_atualizado_de = query.exibir_atualizado === '1' && typeof query.data_atualizado_de === 'string'
        ? query.data_atualizado_de
        : '';
    filtrosPadrao.data_atualizado_ate = query.exibir_atualizado === '1' && typeof query.data_atualizado_ate === 'string'
        ? query.data_atualizado_ate
        : '';

    Object.entries(filtrosPadrao).forEach(([nome, valorPadrao]) => {
        const dataAtualizado = nome === 'data_atualizado_de' || nome === 'data_atualizado_ate';
        const valor = dataAtualizado
            ? valorPadrao
            : Object.prototype.hasOwnProperty.call(query, nome)
                ? query[nome]
                : valorPadrao;
        params.set(nome, typeof valor === 'string' ? valor : '');
    });

    return params.toString();
}

function construirConsultaCobranca(query) {
    const { busca, banco, status_boleto, status_cobranca, gerente_id, vendedor_id, data_vencimento_de, data_vencimento_ate, exibir_atualizado, data_atualizado_de, data_atualizado_ate, exibir_fundo_perdido, ordenar, ordem } = query;
    const exibirAtualizado = exibir_atualizado === '1';
    const statusBoletoInformado = Object.prototype.hasOwnProperty.call(query, 'status_boleto');
    const statusBoletoSelecionado = typeof status_boleto === 'string' ? status_boleto : '';
    const statusBoletoPadrao = !statusBoletoInformado || statusBoletoSelecionado === 'pendentes';
    const filtrosFundoPerdidoValidos = ['ativos', 'perdidos', 'todos'];
    const fundoPerdidoFiltro = typeof exibir_fundo_perdido === 'string' && filtrosFundoPerdidoValidos.includes(exibir_fundo_perdido)
        ? exibir_fundo_perdido
        : 'ativos';
    const colunasOrdenacao = {
        documento: 'b.numero_documento',
        cliente: 'cl.nome',
        vencimento: 'b.data_vencimento',
        previsao: 'b.data_previsao_pagamento',
        valor: 'b.valor_original',
        situacao: 'b.situacao_boleto',
        regua: 'b.status_cobranca',
        atualizado: 'b.atualizado_em'
    };
    const ordenarAtual = typeof ordenar === 'string' && Object.prototype.hasOwnProperty.call(colunasOrdenacao, ordenar)
        ? ordenar
        : 'vencimento';
    const ordemAtual = ordem === 'DESC' ? 'DESC' : 'ASC';
    let queryText = `
            SELECT b.*, cl.nome AS cliente_nome, cl.cnpj_cpf AS cliente_cnpj, cl.email AS cliente_email, cl.telefone AS cliente_telefone,
                   g.nome_resumido AS gerente_nome, g.email AS gerente_email,
                   v.nome_resumido AS vendedor_nome, v.email AS vendedor_email,
                   (SELECT COUNT(*) FROM boletos b2 WHERE b2.excluido_em IS NULL AND b2.cliente_id = b.cliente_id AND b2.situacao_boleto IN ('Vencido', 'Pago com Pendência')) AS total_pendentes_cliente,
                   CASE 
                       WHEN b.situacao_boleto = 'Vencido' THEN (CURRENT_DATE - b.data_vencimento)
                       WHEN b.situacao_boleto IN ('Pago', 'Pago com Pendência') AND b.data_pagamento IS NOT NULL THEN (b.data_pagamento - b.data_vencimento)
                       ELSE 0
                   END AS dias_atraso,
                   ce.id AS estorno_id, ce.data_estorno, ce.valor_estornado, ce.data_restituicao, ce.observacoes AS estorno_obs
            FROM boletos b 
            LEFT JOIN clientes cl ON b.cliente_id = cl.id 
            LEFT JOIN gerentes g ON b.gerente_id = g.id 
            LEFT JOIN vendedores v ON b.vendedor_id = v.id 
            LEFT JOIN comissoes_estornos ce ON ce.boleto_id = b.id
            WHERE b.excluido_em IS NULL
        `;
    const queryParams = [];
    let idx = 1;

    if (busca && busca.trim() !== '') {
        queryText += ' AND (b.numero_documento ILIKE $' + idx + ' OR cl.nome ILIKE $' + idx + ' OR cl.nome_fantasia ILIKE $' + idx + ' OR cl.cnpj_cpf ILIKE $' + idx + ' OR b.banco ILIKE $' + idx + ')';
        queryParams.push('%' + busca.trim() + '%');
        idx++;
    }

    if (statusBoletoPadrao) {
        queryText += " AND b.situacao_boleto IN ('Vencido', 'Pago com Pendência')";
    } else if (statusBoletoSelecionado !== '') {
        queryText += ' AND b.situacao_boleto = $' + idx;
        queryParams.push(statusBoletoSelecionado);
        idx++;
    }

    if (typeof banco === 'string' && banco !== '') {
        queryText += ' AND b.banco = $' + idx;
        queryParams.push(banco);
        idx++;
    }

    if (status_cobranca && status_cobranca !== '') {
        queryText += ' AND b.status_cobranca = $' + idx;
        queryParams.push(status_cobranca);
        idx++;
    }

    if (gerente_id && gerente_id !== '') {
        queryText += ' AND b.gerente_id = $' + idx;
        queryParams.push(parseInt(gerente_id, 10));
        idx++;
    }

    if (vendedor_id && vendedor_id !== '') {
        queryText += ' AND b.vendedor_id = $' + idx;
        queryParams.push(parseInt(vendedor_id, 10));
        idx++;
    }

    if (typeof data_vencimento_de === 'string' && data_vencimento_de !== '') {
        queryText += ' AND b.data_vencimento >= $' + idx;
        queryParams.push(data_vencimento_de);
        idx++;
    }

    if (typeof data_vencimento_ate === 'string' && data_vencimento_ate !== '') {
        queryText += ' AND b.data_vencimento <= $' + idx;
        queryParams.push(data_vencimento_ate);
        idx++;
    }

    if (exibirAtualizado && typeof data_atualizado_de === 'string' && data_atualizado_de !== '') {
        queryText += ' AND b.atualizado_em >= $' + idx + '::date';
        queryParams.push(data_atualizado_de);
        idx++;
    }

    if (exibirAtualizado && typeof data_atualizado_ate === 'string' && data_atualizado_ate !== '') {
        queryText += ' AND b.atualizado_em < ($' + idx + '::date + INTERVAL \'1 day\')';
        queryParams.push(data_atualizado_ate);
        idx++;
    }

    if (fundoPerdidoFiltro === 'ativos') {
        queryText += ' AND b.fundo_perdido IS NOT TRUE';
    } else if (fundoPerdidoFiltro === 'perdidos') {
        queryText += ' AND b.fundo_perdido IS TRUE';
    }

    queryText += ' ORDER BY ' + colunasOrdenacao[ordenarAtual] + ' ' + ordemAtual;
    return { queryText, queryParams, ordenarAtual, ordemAtual, statusBoletoPadrao, statusBoletoSelecionado, fundoPerdidoFiltro, exibirAtualizado };
}

function formatarDataHoraCobranca(valor) {
    if (!valor) return '-';
    const data = valor instanceof Date ? valor : new Date(valor);
    if (Number.isNaN(data.getTime())) return '-';

    const partes = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(data).reduce((resultado, parte) => {
        resultado[parte.type] = parte.value;
        return resultado;
    }, {});
    return `${partes.day}/${partes.month}/${partes.year} às ${partes.hour}:${partes.minute}`;
}

function formatarResultadosCobranca(rows) {
    rows.forEach(b => {
        b.cliente_cnpj = formatarCnpjCpf(b.cliente_cnpj);
        b.valor_original_fmt = formatarMoedaSemSimbolo(b.valor_original);
        b.valor_custas_fmt = formatarMoedaSemSimbolo(b.valor_custas);
        b.valor_estornado_fmt = formatarMoedaSemSimbolo(b.valor_estornado);
        b.atualizado_em_fmt = formatarDataHoraCobranca(b.atualizado_em);
        b.reincidente_pendente = parseInt(b.total_pendentes_cliente, 10) > 1;
        b.dias_atraso = parseInt(b.dias_atraso, 10) > 0 ? parseInt(b.dias_atraso, 10) : 0;
    });
    return rows;
}

app.get('/relatorios/comissoes', verificarAutenticacao, async (req, res) => {
    const dataDe = typeof req.query.data_de === 'string' ? req.query.data_de : '';
    const dataAte = typeof req.query.data_ate === 'string' ? req.query.data_ate : '';
    const vendedorIdInformado = typeof req.query.vendedor_id === 'string' ? req.query.vendedor_id : '';

    if (!validarDataOpcional(dataDe) || !validarDataOpcional(dataAte)) {
        return res.status(400).send('Informe um período válido para o relatório.');
    }
    if (dataDe && dataAte && dataDe > dataAte) {
        return res.status(400).send('A data inicial não pode ser posterior à data final.');
    }

    let vendedorId = null;
    if (vendedorIdInformado) {
        if (!/^\d+$/.test(vendedorIdInformado) || !Number.isSafeInteger(Number(vendedorIdInformado)) ||
            Number(vendedorIdInformado) <= 0) {
            return res.status(400).send('Selecione um vendedor válido.');
        }
        vendedorId = Number(vendedorIdInformado);
    }

    try {
        const [vendedoresRes, comissoesRes] = await Promise.all([
            pool.query('SELECT id, nome_resumido FROM vendedores ORDER BY nome_resumido ASC'),
            pool.query(`
                SELECT
                    v.id AS vendedor_id,
                    v.nome_resumido AS vendedor_nome,
                    COALESCE(SUM(ce.valor_estornado) FILTER (
                        WHERE b.situacao_boleto = 'Vencido'
                          AND b.status_cobranca = 'Em Cartório / Negativado'
                          AND ce.data_estorno IS NULL
                          AND ($2::date IS NULL OR b.data_vencimento >= $2::date)
                          AND ($3::date IS NULL OR b.data_vencimento < ($3::date + INTERVAL '1 day'))
                    ), 0) AS total_debito,
                    COALESCE(SUM(ce.valor_estornado) FILTER (
                        WHERE b.situacao_boleto IN ('Pago', 'Pago com Pendência')
                          AND ce.data_estorno IS NOT NULL
                          AND ce.data_restituicao IS NULL
                          AND ($2::date IS NULL OR ce.data_estorno >= $2::date)
                          AND ($3::date IS NULL OR ce.data_estorno < ($3::date + INTERVAL '1 day'))
                    ), 0) AS total_reembolso
                FROM boletos AS b
                LEFT JOIN clientes AS cl ON cl.id = b.cliente_id
                JOIN vendedores AS v ON v.id = COALESCE(b.vendedor_id, cl.vendedor_id)
                LEFT JOIN comissoes_estornos AS ce ON ce.boleto_id = b.id
                WHERE b.excluido_em IS NULL
                  AND ($1::integer IS NULL OR v.id = $1::integer)
                GROUP BY v.id, v.nome_resumido
                ORDER BY v.nome_resumido ASC
            `, [vendedorId, dataDe || null, dataAte || null])
        ]);

        if (vendedorId !== null && !vendedoresRes.rows.some(vendedor => vendedor.id === vendedorId)) {
            return res.status(400).send('O vendedor selecionado não foi encontrado.');
        }

        const totaisCentavos = { debito: 0, reembolso: 0 };
        const linhas = comissoesRes.rows.map(linha => {
            const totalDebito = Number(linha.total_debito) || 0;
            const totalReembolso = Number(linha.total_reembolso) || 0;
            totaisCentavos.debito += Math.round(totalDebito * 100);
            totaisCentavos.reembolso += Math.round(totalReembolso * 100);
            return {
                ...linha,
                total_debito: totalDebito,
                total_reembolso: totalReembolso
            };
        });
        const totais = {
            debito: totaisCentavos.debito / 100,
            reembolso: totaisCentavos.reembolso / 100
        };

        res.render('relatorio-comissoes', {
            usuario: req.session.usuario,
            linhas,
            vendedores: vendedoresRes.rows,
            filtros: { dataDe, dataAte, vendedorId: vendedorIdInformado },
            totais,
            formatarMoeda: formatarMoedaSemSimbolo
        });
    } catch (err) {
        console.error('ERRO EM GET /relatorios/comissoes:', err);
        res.status(500).send('Erro ao carregar o relatório de comissões.');
    }
});

app.get('/cobranca', verificarAutenticacao, async (req, res) => {
    try {
        const { busca, banco, status_cobranca, gerente_id, vendedor_id, data_vencimento_de, data_vencimento_ate } = req.query;
        const { queryText, queryParams, ordenarAtual, ordemAtual, statusBoletoPadrao, statusBoletoSelecionado, fundoPerdidoFiltro, exibirAtualizado } = construirConsultaCobranca(req.query);
        const result = await pool.query(queryText, queryParams);
        const totalValorOriginal = result.rows.reduce((total, boleto) => total + (parseFloat(boleto.valor_original) || 0), 0);
        const totalCustas = result.rows.reduce((total, boleto) => total + (parseFloat(boleto.valor_custas) || 0), 0);
        const totalValorOriginalFmt = formatarMoedaSemSimbolo(totalValorOriginal);
        const totalCustasFmt = formatarMoedaSemSimbolo(totalCustas);
        const gerentes = await pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
        const vendedores = await pool.query('SELECT id, nome_resumido, gerente_id FROM vendedores WHERE ativo = 1 ORDER BY nome_resumido ASC');
        const bancos = await pool.query("SELECT DISTINCT banco FROM boletos WHERE excluido_em IS NULL AND banco IS NOT NULL AND banco != '' ORDER BY banco ASC");
        const clientes = await pool.query('SELECT id, nome, nome_fantasia, cnpj_cpf FROM clientes ORDER BY nome ASC');
        formatarResultadosCobranca(result.rows);

        res.render('cobranca-lista', { 
            contas: result.rows, 
            gerentes: gerentes.rows,
            vendedores: vendedores.rows,
            bancos: bancos.rows,
            clientesLista: clientes.rows,
            filtrosCobrancaQuery: criarQueryFiltrosCobranca(req.query),
            queryCobrancaCompleta: new URLSearchParams(req.query).toString(),
            buscaAtual: busca || '', 
            bancoAtual: typeof banco === 'string' ? banco : '',
            statusBoletoAtual: statusBoletoPadrao ? 'pendentes' : statusBoletoSelecionado,
            statusCobrancaAtual: status_cobranca || '',
            gerenteAtual: gerente_id || '',
            vendedorAtual: vendedor_id || '',
            dataVencimentoDeAtual: typeof data_vencimento_de === 'string' ? data_vencimento_de : '',
            dataVencimentoAteAtual: typeof data_vencimento_ate === 'string' ? data_vencimento_ate : '',
            exibirAtualizado,
            dataAtualizadoDeAtual: exibirAtualizado && typeof req.query.data_atualizado_de === 'string' ? req.query.data_atualizado_de : '',
            dataAtualizadoAteAtual: exibirAtualizado && typeof req.query.data_atualizado_ate === 'string' ? req.query.data_atualizado_ate : '',
            fundoPerdidoFiltroAtual: fundoPerdidoFiltro,
            ordenarAtual,
            ordemAtual,
            totalValorOriginalFmt,
            totalCustasFmt,
            erro: req.query.erro || null,
            sucesso: req.query.sucesso || null 
        });
    } catch (err) {
        console.error('ERRO EM GET /cobranca:', err);
        res.status(500).send('Erro interno');
    }
});

app.get('/cobranca/relatorio', verificarAutenticacao, async (req, res) => {
    try {
        const consulta = construirConsultaCobranca(req.query);
        const result = await pool.query(consulta.queryText, consulta.queryParams);
        const totalValorOriginal = result.rows.reduce((total, boleto) => total + (parseFloat(boleto.valor_original) || 0), 0);
        const totalCustas = result.rows.reduce((total, boleto) => total + (parseFloat(boleto.valor_custas) || 0), 0);
        const [gerente, vendedor, gerentes, vendedores] = await Promise.all([
            req.query.gerente_id
                ? pool.query('SELECT nome_resumido FROM gerentes WHERE id = $1', [parseInt(req.query.gerente_id, 10)])
                : Promise.resolve({ rows: [] }),
            req.query.vendedor_id
                ? pool.query('SELECT nome_resumido FROM vendedores WHERE id = $1', [parseInt(req.query.vendedor_id, 10)])
                : Promise.resolve({ rows: [] }),
            pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC'),
            pool.query('SELECT id, nome_resumido, gerente_id FROM vendedores WHERE ativo = 1 ORDER BY nome_resumido ASC')
        ]);
        formatarResultadosCobranca(result.rows);

        const situacoes = {
            pendentes: 'Vencido e Pago com Pendência',
            Vencido: 'Vencido',
            Pago: 'Pago',
            'Pago com Pendência': 'Pago com Pendência'
        };
        const fases = {
            'Aguardando Régua': 'Aguardando Régua',
            'Aviso 1 (Notificação)': 'Aviso 1 (Notificação)',
            'Aviso 2 (Alerta Cartório)': 'Aviso 2 (Alerta Cartório)',
            'Aviso 3 (Aviso Final)': 'Aviso 3 (Aviso Final)',
            'Em Cartório / Negativado': 'Em Cartório / Negativado',
            'Custas Pendentes (Cartório)': 'Custas Pendentes (Cartório)',
            Concluído: 'Concluído'
        };
        const nomesOrdenacao = {
            documento: 'Número do documento',
            cliente: 'Cliente',
            vencimento: 'Vencimento',
            previsao: 'Previsão de pagamento',
            valor: 'Valor original',
            situacao: 'Situação',
            regua: 'Fase da régua',
            atualizado: 'Data de atualização'
        };
        const statusSelecionado = req.query.status_boleto;

        res.render('cobranca-relatorio', {
            boletos: result.rows,
            emitidoEm: new Date().toLocaleString('pt-BR'),
            filtros: {
                busca: typeof req.query.busca === 'string' ? req.query.busca : '',
                situacao: statusSelecionado === undefined
                    ? situacoes.pendentes
                    : statusSelecionado === ''
                        ? 'Todas'
                        : situacoes[statusSelecionado] || statusSelecionado,
                banco: typeof req.query.banco === 'string' && req.query.banco ? req.query.banco : 'Todos',
                fase: typeof req.query.status_cobranca === 'string' && req.query.status_cobranca
                    ? fases[req.query.status_cobranca] || req.query.status_cobranca
                    : 'Todas',
                gerente: gerente.rows[0] ? gerente.rows[0].nome_resumido : (req.query.gerente_id ? `ID ${req.query.gerente_id}` : 'Todos'),
                vendedor: vendedor.rows[0] ? vendedor.rows[0].nome_resumido : (req.query.vendedor_id ? `ID ${req.query.vendedor_id}` : 'Todos'),
                fundoPerdido: {
                    ativos: 'Apenas Ativos (padrão)',
                    perdidos: 'Apenas Fundo Perdido',
                    todos: 'Todos'
                }[consulta.fundoPerdidoFiltro],
                vencimentoDe: typeof req.query.data_vencimento_de === 'string' && req.query.data_vencimento_de
                    ? new Date(`${req.query.data_vencimento_de}T00:00:00`).toLocaleDateString('pt-BR')
                    : 'Não definido',
                vencimentoAte: typeof req.query.data_vencimento_ate === 'string' && req.query.data_vencimento_ate
                    ? new Date(`${req.query.data_vencimento_ate}T00:00:00`).toLocaleDateString('pt-BR')
                    : 'Não definido',
                ordenar: nomesOrdenacao[consulta.ordenarAtual],
                ordem: consulta.ordemAtual === 'ASC' ? 'Crescente' : 'Decrescente',
                exibirAtualizado: consulta.exibirAtualizado,
                atualizadoDe: consulta.exibirAtualizado && req.query.data_atualizado_de
                    ? new Date(`${req.query.data_atualizado_de}T00:00:00`).toLocaleDateString('pt-BR')
                    : 'Não definido',
                atualizadoAte: consulta.exibirAtualizado && req.query.data_atualizado_ate
                    ? new Date(`${req.query.data_atualizado_ate}T00:00:00`).toLocaleDateString('pt-BR')
                    : 'Não definido'
            },
            totalValorOriginalFmt: formatarMoedaSemSimbolo(totalValorOriginal),
            totalCustasFmt: formatarMoedaSemSimbolo(totalCustas),
            queryString: req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '',
            gerentes: gerentes.rows,
            vendedores: vendedores.rows
        });
    } catch (err) {
        console.error('ERRO EM GET /cobranca/relatorio:', err);
        res.status(500).send('Erro interno ao gerar relatório');
    }
});

app.post('/cobranca/relatorio/envio', verificarAutenticacao, async (req, res) => {
    const { gerente_id, vendedor_id, canal, cc, formato } = req.body;
    const gerenteId = Number(gerente_id);
    const vendedorSomenteGerente = vendedor_id === 'nenhum' || vendedor_id === '';
    const vendedorTodos = vendedor_id === 'todos';
    const vendedorId = vendedorSomenteGerente || vendedorTodos ? null : Number(vendedor_id);

    if (!Number.isSafeInteger(gerenteId) || gerenteId <= 0 ||
        (!vendedorSomenteGerente && !vendedorTodos && (!Number.isSafeInteger(vendedorId) || vendedorId <= 0)) ||
        !['email', 'whatsapp'].includes(canal) ||
        !['pdf', 'excel'].includes(formato)) {
        return res.status(400).json({ erro: 'Selecione gerente, vendedor, canal e formato válidos.' });
    }

    const emailsCc = canal === 'email' && typeof cc === 'string'
        ? cc.split(',').map(email => email.trim()).filter(Boolean)
        : [];
    const formatoEmailValido = /^[^\s,;@]+@[^\s,;@]+\.[^\s,;@]+$/;
    if (emailsCc.some(email => !formatoEmailValido.test(email))) {
        return res.status(400).json({ erro: 'Confira os endereços informados no campo Com Cópia (CC).' });
    }

    try {
        const gerenteRes = await pool.query(
            'SELECT id, nome_resumido, email, telefone FROM gerentes WHERE id = $1 AND ativo = 1',
            [gerenteId]
        );
        if (!gerenteRes.rows.length) {
            return res.status(400).json({ erro: 'O gerente selecionado não está ativo ou não foi encontrado.' });
        }

        const vendedoresRes = vendedorTodos
            ? await pool.query(
                'SELECT id, nome_resumido, email, telefone FROM vendedores WHERE gerente_id = $1 AND ativo = 1 ORDER BY nome_resumido ASC',
                [gerenteId]
            )
            : vendedorSomenteGerente
                ? { rows: [] }
                : await pool.query(
                    'SELECT id, nome_resumido, email, telefone FROM vendedores WHERE id = $1 AND gerente_id = $2 AND ativo = 1',
                    [vendedorId, gerenteId]
                );
        if (!vendedorSomenteGerente && !vendedorTodos && !vendedoresRes.rows.length) {
            return res.status(400).json({ erro: 'O vendedor selecionado não pertence ao gerente ou não está ativo.' });
        }

        const gerente = gerenteRes.rows[0];
        const vendedoresDestino = vendedoresRes.rows;
        const filtrosQuery = criarQueryFiltrosCobranca(req.query);
        const caminhoArquivo = formato === 'excel' ? '/cobranca/relatorio/csv' : '/cobranca/relatorio';
        const arquivoUrl = `${caminhoArquivo}?${filtrosQuery}`;
        const nomesDestino = [gerente.nome_resumido, ...vendedoresDestino.map(v => v.nome_resumido)].filter(Boolean);
        const corpo = [
            'Olá,',
            '',
            'Segue o relatório de cobrança da equipe.',
            '',
            `Destinatários: ${nomesDestino.join(', ')}`,
            'O envio é preparado manualmente pelo sistema. Baixe o relatório na tela aberta e anexe-o antes de enviar.',
            '',
            'Atenciosamente,',
            'Setor Financeiro - Omnia'
        ].join('\n');
        const titulo = formato === 'excel' ? 'Baixar relatório CSV' : 'Abrir relatório para salvar em PDF';

        if (canal === 'email') {
            const destinatarios = [gerente, ...vendedoresDestino]
                .map(pessoa => pessoa.email)
                .filter(Boolean);
            if (!destinatarios.length) {
                return res.status(400).json({ erro: 'O gerente e os vendedores selecionados não possuem e-mail cadastrado.' });
            }

            const assunto = 'Relatório de Contas em Aberto - Cobrança';
            const mailtoUrl = `mailto:${encodeURIComponent(destinatarios.join(','))}?cc=${encodeURIComponent(emailsCc.join(','))}&subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(corpo)}`;
            return res.json({
                canal,
                arquivoUrl,
                tituloArquivo: titulo,
                mailtoUrl,
                observacao: 'Baixe ou abra o relatório e anexe-o ao rascunho. O e-mail ainda precisa ser enviado pelo seu cliente de e-mail.'
            });
        }

        const destinosWhatsapp = [gerente, ...vendedoresDestino]
            .filter(pessoa => pessoa.telefone)
            .map(pessoa => ({
                nome: pessoa.nome_resumido,
                url: `https://wa.me/${String(pessoa.telefone).replace(/\D/g, '')}?text=${encodeURIComponent(corpo)}`
            }))
            .filter(destino => /wa\.me\/\d+/.test(destino.url));
        if (!destinosWhatsapp.length) {
            return res.status(400).json({ erro: 'O gerente e os vendedores selecionados não possuem telefone válido cadastrado.' });
        }

        return res.json({
            canal,
            arquivoUrl,
            tituloArquivo: titulo,
            destinosWhatsapp,
            observacao: 'Baixe ou abra o relatório e anexe-o na conversa do WhatsApp. A mensagem deve ser enviada manualmente.'
        });
    } catch (err) {
        console.error('ERRO AO PREPARAR ENVIO DO RELATÓRIO DE COBRANÇA:', err);
        res.status(500).json({ erro: 'Erro ao preparar o envio do relatório.' });
    }
});

app.get('/cobranca/relatorio/csv', verificarAutenticacao, async (req, res) => {
    try {
        const consulta = construirConsultaCobranca(req.query);
        const result = await pool.query(consulta.queryText, consulta.queryParams);
        const totalValorOriginal = result.rows.reduce((total, boleto) => total + (parseFloat(boleto.valor_original) || 0), 0);
        const totalCustas = result.rows.reduce((total, boleto) => total + (parseFloat(boleto.valor_custas) || 0), 0);
        const escaparCampoCsv = (valor, protegerFormula = false) => {
            let texto = valor == null ? '' : String(valor);
            if (protegerFormula && /^[\t\r\n ]*[=+\-@]/.test(texto)) {
                texto = `'${texto}`;
            }
            return `"${texto.replace(/"/g, '""')}"`;
        };
        const formatarDataCsv = valor => {
            if (!valor) return '';
            const data = valor instanceof Date ? valor.toISOString().slice(0, 10) : String(valor).slice(0, 10);
            const partes = data.split('-');
            return partes.length === 3 ? `${partes[2]}/${partes[1]}/${partes[0]}` : '';
        };
        const cabecalho = [
            'Nº Documento',
            'Cliente',
            'CNPJ/CPF',
            'Gerente',
            'Vendedor',
            'Vencimento',
            'Data de Emissão',
            'Situação',
            'Fase da Régua',
            'Valor Original',
            'Custas'
        ];
        const linhas = result.rows.map(boleto => [
            escaparCampoCsv(boleto.numero_documento, true),
            escaparCampoCsv(boleto.cliente_nome, true),
            escaparCampoCsv(formatarCnpjCpf(boleto.cliente_cnpj), true),
            escaparCampoCsv(boleto.gerente_nome, true),
            escaparCampoCsv(boleto.vendedor_nome, true),
            escaparCampoCsv(formatarDataCsv(boleto.data_vencimento)),
            escaparCampoCsv(formatarDataCsv(boleto.data_emissao)),
            escaparCampoCsv(boleto.situacao_boleto, true),
            escaparCampoCsv(boleto.status_cobranca || 'Aguardando Régua', true),
            escaparCampoCsv(formatarMoedaSemSimbolo(boleto.valor_original)),
            escaparCampoCsv(formatarMoedaSemSimbolo(boleto.valor_custas))
        ].join(';'));
        const linhaTotais = [
            escaparCampoCsv('Totais'),
            ...Array(8).fill('""'),
            escaparCampoCsv(formatarMoedaSemSimbolo(totalValorOriginal)),
            escaparCampoCsv(formatarMoedaSemSimbolo(totalCustas))
        ].join(';');
        const csv = `\uFEFF${cabecalho.map(campo => escaparCampoCsv(campo)).join(';')}\r\n${linhas.join('\r\n')}${linhas.length ? '\r\n' : ''}${linhaTotais}\r\n`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="relatorio-cobranca.csv"');
        res.send(csv);
    } catch (err) {
        console.error('ERRO EM GET /cobranca/relatorio/csv:', err);
        res.status(500).send('Erro interno ao exportar relatório');
    }
});

// ROTA PARA SALVAR / ATUALIZAR ESTORNO DE COMISSÃO VIA MODAL
app.post('/cobranca/estorno/:id', verificarAutenticacao, async (req, res) => {
    const boletoId = req.params.id;
    const { data_estorno, valor_estornado, data_restituicao, observacoes } = req.body;
    if ((valor_estornado !== undefined && valor_estornado !== '' &&
            !validarValorMonetario(valor_estornado, { permitirZero: true })) ||
        ![data_estorno, data_restituicao].every(validarDataOpcional)) {
        return res.redirect(`/cobranca?erro=${encodeURIComponent('Valor ou data do estorno inválido.')}`);
    }

    try {
        // Buscar o vendedor_id vinculado ao boleto
        const bolRes = await pool.query('SELECT vendedor_id FROM boletos WHERE id = $1 AND excluido_em IS NULL', [boletoId]);
        let vendedorId = bolRes.rows.length > 0 ? bolRes.rows[0].vendedor_id : null;

        // Verificar se já existe estorno para este boleto
        const estRes = await pool.query('SELECT id FROM comissoes_estornos WHERE boleto_id = $1', [boletoId]);

        if (estRes.rows.length > 0) {
            // Atualizar
            const sqlUpdate = `UPDATE comissoes_estornos SET data_estorno = $1, valor_estornado = $2, data_restituicao = $3, observacoes = $4 WHERE boleto_id = $5`;
            await pool.query(sqlUpdate, [
                tratarData(data_estorno),
                limparValorMonetario(valor_estornado),
                tratarData(data_restituicao),
                formatarCapitalizacao(observacoes),
                boletoId
            ]);
        } else {
            // Inserir novo
            const sqlInsert = `INSERT INTO comissoes_estornos (boleto_id, vendedor_id, data_estorno, valor_estornado, data_restituicao, observacoes) VALUES ($1, $2, $3, $4, $5, $6)`;
            await pool.query(sqlInsert, [
                boletoId,
                vendedorId,
                tratarData(data_estorno),
                limparValorMonetario(valor_estornado),
                tratarData(data_restituicao),
                formatarCapitalizacao(observacoes)
            ]);
        }

        res.redirect('/cobranca?sucesso=Controle de estorno atualizado com sucesso!');
    } catch (err) {
        console.error('ERRO AO SALVAR ESTORNO:', err);
        res.redirect('/cobranca?erro=Erro ao salvar estorno de comissão.');
    }
});

app.get('/cobranca/nova', verificarAutenticacao, async (req, res) => {
    try {
        const clientes = await pool.query(`
            SELECT c.id, c.nome, c.gerente_id, c.vendedor_id, 
                   g.nome_resumido AS gerente_nome, v.nome_resumido AS vendedor_nome 
            FROM clientes c 
            LEFT JOIN gerentes g ON c.gerente_id = g.id 
            LEFT JOIN vendedores v ON c.vendedor_id = v.id 
            WHERE c.ativo = 1 
            ORDER BY c.nome ASC
        `);
        const gerentes = await pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
        const vendedores = await pool.query('SELECT v.id, v.nome_resumido, v.gerente_id FROM vendedores v WHERE v.ativo = 1 ORDER BY v.nome_resumido ASC');

        res.render('cobranca-form', { 
            conta: null, 
            clientes: clientes.rows, 
            gerentes: gerentes.rows, 
            vendedores: vendedores.rows, 
            filtrosCobrancaQuery: criarQueryFiltrosCobranca(req.query),
            historico: [],
            erro: req.query.erro || null,
            sucesso: null 
        });
    } catch (err) {
        console.error(err);
        res.redirect('/cobranca?erro=Erro ao carregar formulário.');
    }
});

app.post('/cobranca/novo', verificarAutenticacao, async (req, res) => {
    const { cliente_id, gerente_id, vendedor_id, numero_documento, banco, carteira, valor_original, data_emissao, data_vencimento, situacao_boleto, status_cobranca, data_previsao_pagamento, observacoes } = req.body;

    try {
        const erroValidacao = validarDadosBoleto({
            valor_original,
            situacao_boleto: situacao_boleto || 'Vencido',
            status_cobranca: status_cobranca || 'Aguardando Régua'
        }) || (![data_emissao, data_vencimento, data_previsao_pagamento].every(validarDataOpcional)
            ? 'Uma ou mais datas informadas são inválidas.'
            : null);
        if (erroValidacao) {
            return res.redirect(`/cobranca/nova?erro=${encodeURIComponent(erroValidacao)}`);
        }
        if (typeof cliente_id !== 'string' || !/^\d+$/.test(cliente_id) ||
            typeof numero_documento !== 'string' || !numero_documento.trim()) {
            return res.redirect(`/cobranca/nova?erro=${encodeURIComponent('Informe um cliente e um número de documento válidos.')}`);
        }
        const clienteId = parseInt(cliente_id, 10);
        const numeroDocumento = numero_documento ? numero_documento.trim().toUpperCase() : '';
        const boletoExistente = await pool.query(
            `SELECT id FROM boletos
             WHERE excluido_em IS NULL AND cliente_id = $1 AND UPPER(numero_documento) = $2
             LIMIT 1`,
            [clienteId, numeroDocumento]
        );
        if (boletoExistente.rows.length > 0) {
            const clientes = await pool.query('SELECT c.id, c.nome, c.gerente_id, c.vendedor_id, g.nome_resumido AS gerente_nome, v.nome_resumido AS vendedor_nome FROM clientes c LEFT JOIN gerentes g ON c.gerente_id = g.id LEFT JOIN vendedores v ON c.vendedor_id = v.id WHERE c.ativo = 1 ORDER BY c.nome ASC');
            const gerentes = await pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
            const vendedores = await pool.query('SELECT v.id, v.nome_resumido, v.gerente_id FROM vendedores v WHERE v.ativo = 1 ORDER BY v.nome_resumido ASC');
            return res.status(409).render('cobranca-form', {
                conta: req.body,
                clientes: clientes.rows,
                gerentes: gerentes.rows,
                vendedores: vendedores.rows,
                filtrosCobrancaQuery: criarQueryFiltrosCobranca(req.query),
                historico: [],
                erro: 'Este número de documento já foi lançado para este cliente.',
                sucesso: null
            });
        }

        const gerenteId = gerente_id ? parseInt(gerente_id, 10) : null;
        const vendedorId = vendedor_id ? parseInt(vendedor_id, 10) : null;

        const sql = `INSERT INTO boletos (
            cliente_id, gerente_id, vendedor_id, numero_documento, banco, carteira, valor_original, 
            data_emissao, data_vencimento, situacao_boleto, status_cobranca, data_previsao_pagamento, observacoes, criado_em, atualizado_em, data_fase_cobranca
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;

        await pool.query(sql, [
            parseInt(cliente_id, 10),
            gerenteId,
            vendedorId,
            numeroDocumento,
            banco || null,
            carteira || 'Simples',
            limparValorMonetario(valor_original),
            tratarData(data_emissao),
            tratarData(data_vencimento),
            situacao_boleto || 'Vencido',
            status_cobranca || 'Aguardando Régua',
            tratarData(data_previsao_pagamento),
            formatarCapitalizacao(observacoes)
        ]);

        const paramsRetorno = new URLSearchParams(criarQueryFiltrosCobranca(req.query));
        paramsRetorno.set('sucesso', 'Boleto cadastrado com sucesso!');
        res.redirect(`/cobranca?${paramsRetorno.toString()}`);
    } catch (err) {
        console.error('ERRO AO CADASTRAR BOLETO:', err);
        const clientes = await pool.query('SELECT c.id, c.nome, c.gerente_id, c.vendedor_id, g.nome_resumido AS gerente_nome, v.nome_resumido AS vendedor_nome FROM clientes c LEFT JOIN gerentes g ON c.gerente_id = g.id LEFT JOIN vendedores v ON c.vendedor_id = v.id WHERE c.ativo = 1 ORDER BY c.nome ASC');
        const gerentes = await pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
        const vendedores = await pool.query('SELECT v.id, v.nome_resumido, v.gerente_id FROM vendedores v WHERE v.ativo = 1 ORDER BY v.nome_resumido ASC');

        res.render('cobranca-form', { 
            conta: req.body, 
            clientes: clientes.rows, 
            gerentes: gerentes.rows, 
            vendedores: vendedores.rows, 
            filtrosCobrancaQuery: criarQueryFiltrosCobranca(req.query),
            historico: [],
            erro: err.code === '23505'
                ? 'Este número de documento já foi lançado para este cliente.'
                : 'Erro ao cadastrar boleto. Confira os dados e tente novamente.',
            sucesso: null 
        });
    }
});

app.get('/cobranca/nota-debito/:id', verificarAutenticacao, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, cl.nome AS cliente_nome,
                   cl.nome_fantasia AS cliente_nome_fantasia,
                   cl.cnpj_cpf AS cliente_cnpj
            FROM boletos b
            LEFT JOIN clientes cl ON cl.id = b.cliente_id
            WHERE b.id = $1 AND b.excluido_em IS NULL
        `, [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).send('Boleto não encontrado.');
        }

        const boleto = result.rows[0];
        const valorOriginalCentavos = Math.round((Number(boleto.valor_original) || 0) * 100);
        const valorCustasCentavos = Math.round((Number(boleto.valor_custas) || 0) * 100);
        const boletoVencido = boleto.situacao_boleto === 'Vencido';
        const valorEncargoCentavos = boletoVencido
            ? valorOriginalCentavos + valorCustasCentavos
            : valorCustasCentavos;
        const conta = {
            ...boleto,
            cliente_cnpj: formatarCnpjCpf(result.rows[0].cliente_cnpj),
            valor_original_fmt: formatarMoedaSemSimbolo(result.rows[0].valor_original),
            valor_custas_fmt: formatarMoedaSemSimbolo(result.rows[0].valor_custas),
            descricao_encargo: boletoVencido
                ? `Encargo acumulado referente ao documento original Nº ${boleto.numero_documento}, incluindo o valor do título e as custas cartorárias.`
                : 'Ressarcimento de Custas Cartorárias, multa e juros por Atraso',
            valor_encargo_fmt: formatarMoedaSemSimbolo(valorEncargoCentavos / 100),
            valor_total_nota_fmt: formatarMoedaSemSimbolo(valorEncargoCentavos / 100),
            descricao_nota: boletoVencido
                ? `A presente Nota de Débito refere-se ao valor do título original Nº ${boleto.numero_documento}, acrescido das custas cartorárias decorrentes do atraso.`
                : 'A presente Nota de Débito refere-se ao ressarcimento de despesas operacionais e bancárias decorrentes do atraso do pagamento do título original abaixo especificado, o qual precisou ser encaminhado a protesto em cartório devido ao inadimplemento na data de vencimento.'
        };

        res.render('nota-debito', { conta });
    } catch (err) {
        console.error('ERRO AO GERAR NOTA DE DÉBITO:', err);
        res.status(500).send('Erro interno');
    }
});

app.post('/cobranca/nota-debito/:id/registrar', verificarAutenticacao, async (req, res) => {
    try {
        const boleto = await pool.query(
            'SELECT id, cliente_id FROM boletos WHERE id = $1 AND excluido_em IS NULL',
            [req.params.id]
        );
        if (boleto.rows.length === 0) return res.status(404).send('Boleto não encontrado.');
        await pool.query(`
            INSERT INTO boletos_historico
                (boleto_id, usuario_id, tipo_contato, canal, contato_nome, resumo, status, data_hora)
            SELECT b.id, $2, 'Cliente', 'E-mail', c.nome, $3, 'Registrado', CURRENT_TIMESTAMP
            FROM boletos b
            LEFT JOIN clientes c ON c.id = b.cliente_id
            WHERE b.id = $1 AND b.excluido_em IS NULL
        `, [boleto.rows[0].id, req.session.usuario.id, 'Nota de Débito gerada para envio ao cliente']);
        res.redirect(303, `/cobranca/nota-debito/${boleto.rows[0].id}`);
    } catch (err) {
        console.error('ERRO AO REGISTRAR NOTA DE DÉBITO:', err);
        res.status(500).send('Erro ao registrar a nota de débito.');
    }
});

// EDITAR BOLETO E EXIBIR HISTÓRICO DA RÉGUA
app.get('/cobranca/editar/:id', verificarAutenticacao, async (req, res) => {
    try {
        const boletoId = req.params.id;
        const boletoRes = await pool.query(`
            SELECT b.*, cl.nome AS cliente_nome, cl.nome_fantasia AS cliente_nome_fantasia,
                   cl.email AS cliente_email, cl.telefone AS cliente_telefone,
                   g.id AS gerente_vinculado_id, g.nome_resumido AS gerente_nome, g.email AS gerente_email,
                   v.id AS vendedor_vinculado_id, v.nome_resumido AS vendedor_nome, v.email AS vendedor_email
            FROM boletos b 
            LEFT JOIN clientes cl ON b.cliente_id = cl.id 
            LEFT JOIN vendedores v ON v.id = COALESCE(b.vendedor_id, cl.vendedor_id)
            LEFT JOIN gerentes g ON g.id = COALESCE(b.gerente_id, cl.gerente_id, v.gerente_id)
            WHERE b.id = $1 AND b.excluido_em IS NULL
        `, [boletoId]);
        
        if (boletoRes.rows.length === 0) {
            const filtrosQuery = criarQueryFiltrosCobranca(req.query);
            return res.redirect(`/cobranca?${filtrosQuery}&erro=Boleto não encontrado.`);
        }

        const clientes = await pool.query(`
            SELECT c.id, c.nome, c.gerente_id, c.vendedor_id, 
                   g.nome_resumido AS gerente_nome, v.nome_resumido AS vendedor_nome 
            FROM clientes c 
            LEFT JOIN gerentes g ON c.gerente_id = g.id 
            LEFT JOIN vendedores v ON c.vendedor_id = v.id 
            WHERE c.ativo = 1 
            ORDER BY c.nome ASC
        `);
        const gerentes = await pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
        const vendedores = await pool.query('SELECT v.id, v.nome_resumido, v.gerente_id FROM vendedores v WHERE v.ativo = 1 ORDER BY v.nome_resumido ASC');

        // Buscar histórico de contatos/interações
        const historicoRes = await pool.query(`
            SELECT h.*, u.nome AS usuario_nome 
            FROM boletos_historico h 
            LEFT JOIN usuarios u ON h.usuario_id = u.id 
            WHERE h.boleto_id = $1 AND h.excluido_em IS NULL
            ORDER BY h.data_hora DESC
        `, [boletoId]);

        const contaObj = {
            ...boletoRes.rows[0],
            valor_original: formatarMoedaSemSimbolo(boletoRes.rows[0].valor_original),
            valor_custas: formatarMoedaSemSimbolo(boletoRes.rows[0].valor_custas)
        };

        res.render('cobranca-form', { 
            conta: contaObj, 
            clientes: clientes.rows, 
            gerentes: gerentes.rows, 
            vendedores: vendedores.rows, 
            filtrosCobrancaQuery: criarQueryFiltrosCobranca(req.query),
            historico: historicoRes.rows,
            erro: req.query.erro || null,
            sucesso: req.query.sucesso || null 
        });
    } catch (err) {
        console.error(err);
        const filtrosQuery = criarQueryFiltrosCobranca(req.query);
        res.redirect(`/cobranca?${filtrosQuery}&erro=Erro ao carregar edição do boleto.`);
    }
});

// SALVAR ALTERAÇÕES DO BOLETO
app.post('/cobranca/editar/:id', verificarAutenticacao, async (req, res) => {
    const boletoId = req.params.id;
    const { 
        cliente_id, gerente_id, vendedor_id, numero_documento, banco, carteira, valor_original, data_emissao, data_vencimento,
        situacao_boleto, status_cobranca, data_previsao_pagamento, data_cartorio, valor_custas, 
        data_pagamento, data_pagamento_custas, observacoes, fundo_perdido
    } = req.body;

    let db;
    let transactionStarted = false;
    try {
        const erroValidacao = validarDadosBoleto({
            valor_original,
            valor_custas,
            situacao_boleto,
            status_cobranca,
            data_pagamento
        }) || (![data_emissao, data_vencimento, data_previsao_pagamento, data_cartorio, data_pagamento_custas]
            .every(validarDataOpcional)
            ? 'Uma ou mais datas informadas são inválidas.'
            : null);
        if (erroValidacao) {
            return res.redirect(`/cobranca/editar/${encodeURIComponent(boletoId)}?erro=${encodeURIComponent(erroValidacao)}`);
        }
        if (status_cobranca === 'Em Cartório / Negativado' && !data_cartorio) {
            return res.redirect(`/cobranca/editar/${encodeURIComponent(boletoId)}?erro=${encodeURIComponent('Informe a data de encaminhamento ao cartório.')}`);
        }
        if (typeof cliente_id !== 'string' || !/^\d+$/.test(cliente_id) ||
            typeof numero_documento !== 'string' || !numero_documento.trim()) {
            return res.redirect(`/cobranca/editar/${encodeURIComponent(boletoId)}?erro=${encodeURIComponent('Informe um cliente e um número de documento válidos.')}`);
        }
        const gerenteId = gerente_id ? parseInt(gerente_id, 10) : null;
        const vendedorId = vendedor_id ? parseInt(vendedor_id, 10) : null;

        db = await pool.connect();
        await db.query('BEGIN');
        transactionStarted = true;
        const boletoAtual = await db.query(
            'SELECT status_cobranca FROM boletos WHERE id = $1 AND excluido_em IS NULL FOR UPDATE',
            [parseInt(boletoId, 10)]
        );
        if (boletoAtual.rows.length === 0) {
            await db.query('ROLLBACK');
            transactionStarted = false;
            return res.redirect(`/cobranca?erro=${encodeURIComponent('Boleto não encontrado ou arquivado.')}`);
        }

        const faseAnterior = boletoAtual.rows[0].status_cobranca || 'Aguardando Régua';
        const faseNova = status_cobranca || faseAnterior;
        if (!fasesCobrancaValidas.includes(faseNova)) {
            await db.query('ROLLBACK');
            transactionStarted = false;
            return res.redirect(`/cobranca/editar/${encodeURIComponent(boletoId)}?erro=${encodeURIComponent('A fase da régua de cobrança é inválida.')}`);
        }
        if (faseNova !== faseAnterior &&
            ['Aviso 1 (Notificação)', 'Aviso 2 (Alerta Cartório)', 'Aviso 3 (Aviso Final)'].includes(faseNova)) {
            await db.query('ROLLBACK');
            transactionStarted = false;
            return res.redirect(`/cobranca/editar/${encodeURIComponent(boletoId)}?erro=${encodeURIComponent('Confirme o envio do e-mail da régua para avançar esta fase.')}`);
        }

        const sql = `UPDATE boletos SET 
            cliente_id = $1, gerente_id = $2, vendedor_id = $3, numero_documento = $4, banco = $5, 
            carteira = $6, valor_original = $7, data_emissao = $8, data_vencimento = $9, 
            situacao_boleto = $10, status_cobranca = $11::text, data_previsao_pagamento = $12,
            data_cartorio = $13, valor_custas = $14, data_pagamento = $15, data_pagamento_custas = $16,
            observacoes = $17, fundo_perdido = $18, atualizado_em = CURRENT_TIMESTAMP,
            data_fase_cobranca = CASE
                WHEN status_cobranca IS DISTINCT FROM $11::text THEN CURRENT_TIMESTAMP
                ELSE COALESCE(data_fase_cobranca, CURRENT_TIMESTAMP)
            END
            WHERE id = $19 AND excluido_em IS NULL`;

        await db.query(sql, [
            parseInt(cliente_id, 10),
            gerenteId,
            vendedorId,
            numero_documento ? numero_documento.trim().toUpperCase() : '',
            banco || null,
            carteira || 'Simples',
            limparValorMonetario(valor_original),
            tratarData(data_emissao),
            tratarData(data_vencimento),
            situacao_boleto || 'Vencido',
            faseNova,
            tratarData(data_previsao_pagamento),
            tratarData(data_cartorio),
            limparValorMonetario(valor_custas),
            tratarData(data_pagamento),
            tratarData(data_pagamento_custas),
            formatarCapitalizacao(observacoes),
            fundo_perdido === 'true',
            parseInt(boletoId, 10)
        ]);

        if (faseNova !== faseAnterior) {
            await db.query(`
                INSERT INTO boletos_historico
                    (boleto_id, usuario_id, tipo_contato, canal, contato_nome, resumo, status, data_hora)
                VALUES ($1, $2, 'Interno', 'Sistema', $3, $4, 'Registrado', CURRENT_TIMESTAMP)
            `, [
                parseInt(boletoId, 10),
                req.session.usuario.id,
                req.session.usuario.nome || 'Usuário',
                `Fase da régua alterada de "${faseAnterior}" para "${faseNova}" pelo formulário.`
            ]);
        }
        if (faseNova === 'Em Cartório / Negativado' &&
            faseAnterior === 'Aviso 3 (Aviso Final)') {
            await db.query(`
                UPDATE boletos_regua_pendencias
                SET status = 'Concluida', concluido_em = CURRENT_TIMESTAMP,
                    concluido_por = $2
                WHERE boleto_id = $1 AND etapa = 4 AND status = 'Pendente'
            `, [parseInt(boletoId, 10), req.session.usuario.id]);
        }
        await db.query('COMMIT');
        transactionStarted = false;

        const paramsRetorno = new URLSearchParams(criarQueryFiltrosCobranca(req.query));
        paramsRetorno.set('sucesso', 'Boleto atualizado com sucesso!');
        res.redirect(`/cobranca?${paramsRetorno.toString()}`);
    } catch (err) {
        if (db && transactionStarted) {
            try {
                await db.query('ROLLBACK');
            } catch (rollbackErr) {
                console.error('ERRO AO DESFAZER ATUALIZAÇÃO DO BOLETO:', rollbackErr);
            }
        }
        console.error('ERRO AO EDITAR BOLETO:', err);
        const filtrosQuery = criarQueryFiltrosCobranca(req.query);
        const mensagem = err.code === '23505'
            ? 'Este número de documento já foi lançado para este cliente.'
            : 'Erro ao atualizar boleto.';
        res.redirect(`/cobranca/editar/${boletoId}?${filtrosQuery}&erro=${encodeURIComponent(mensagem)}`);
    } finally {
        if (db) db.release();
    }
});

// DUPLICAR LANÇAMENTO DE BOLETO
app.get('/cobranca/duplicar/:id', verificarAutenticacao, async (req, res) => {
    try {
        const boletoOriginal = await pool.query('SELECT * FROM boletos WHERE id = $1 AND excluido_em IS NULL', [req.params.id]);
        if (boletoOriginal.rows.length === 0) {
            return res.redirect('/cobranca?erro=Boleto para duplicação não encontrado.');
        }

        const clientes = await pool.query(`
            SELECT c.id, c.nome, c.gerente_id, c.vendedor_id, 
                   g.nome_resumido AS gerente_nome, v.nome_resumido AS vendedor_nome 
            FROM clientes c 
            LEFT JOIN gerentes g ON c.gerente_id = g.id 
            LEFT JOIN vendedores v ON c.vendedor_id = v.id 
            WHERE c.ativo = 1 
            ORDER BY c.nome ASC
        `);
        const gerentes = await pool.query('SELECT id, nome_resumido FROM gerentes WHERE ativo = 1 ORDER BY nome_resumido ASC');
        const vendedores = await pool.query('SELECT v.id, v.nome_resumido, v.gerente_id FROM vendedores v WHERE v.ativo = 1 ORDER BY v.nome_resumido ASC');

        const boletoDuplicado = {
            ...boletoOriginal.rows[0],
            id: null,
            data_vencimento: null,
            valor_original: formatarMoedaSemSimbolo(boletoOriginal.rows[0].valor_original),
            valor_custas: '0,00',
            situacao_boleto: 'Vencido',
            status_cobranca: 'Aguardando Régua'
        };

        res.render('cobranca-form', { 
            conta: boletoDuplicado, 
            clientes: clientes.rows, 
            gerentes: gerentes.rows, 
            vendedores: vendedores.rows, 
            filtrosCobrancaQuery: criarQueryFiltrosCobranca(req.query),
            historico: [],
            erro: null, 
            sucesso: 'Lançamento duplicado! Informe a nova data de vencimento.' 
        });
    } catch (err) {
        console.error('ERRO AO DUPLICAR BOLETO:', err);
        res.redirect('/cobranca?erro=Erro ao duplicar boleto.');
    }
});

const etapasEmailRegua = {
    1: { faseAnterior: 'Aguardando Régua', fase: 'Aviso 1 (Notificação)', tipoAcao: 'E-mail 1 - Aviso de Vencimento' },
    2: { faseAnterior: 'Aviso 1 (Notificação)', fase: 'Aviso 2 (Alerta Cartório)', tipoAcao: 'E-mail 2 - Risco de Cartório' },
    3: { faseAnterior: 'Aviso 2 (Alerta Cartório)', fase: 'Aviso 3 (Aviso Final)', tipoAcao: 'E-mail 3 - Aviso Final (Próximo Dia Útil)' }
};

function formatarDataEmail(data) {
    if (!data) return 'Não informado';
    if (data instanceof Date) {
        return data.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    }

    const texto = String(data).trim();
    const dataIso = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dataIso) return `${dataIso[3]}/${dataIso[2]}/${dataIso[1]}`;

    const dataConvertida = new Date(texto);
    return Number.isNaN(dataConvertida.getTime())
        ? 'Não informado'
        : dataConvertida.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

async function carregarEmailAvisoComercial(boletoId, executor = pool) {
    const boletoRes = await executor.query(`
        SELECT b.id, b.cliente_id, b.numero_documento, b.data_vencimento, b.valor_original,
               b.valor_custas, b.situacao_boleto, b.status_cobranca,
               cl.cnpj_cpf AS cliente_cnpj, cl.nome AS cliente_nome,
               cl.nome_fantasia AS cliente_nome_fantasia,
               g.email AS gerente_email, v.email AS vendedor_email
        FROM boletos b
        LEFT JOIN clientes cl ON cl.id = b.cliente_id
        LEFT JOIN vendedores v ON v.id = COALESCE(b.vendedor_id, cl.vendedor_id)
        LEFT JOIN gerentes g ON g.id = COALESCE(b.gerente_id, cl.gerente_id, v.gerente_id)
        WHERE b.id = $1 AND b.excluido_em IS NULL
    `, [boletoId]);

    if (boletoRes.rows.length === 0) return null;

    const boleto = boletoRes.rows[0];
    const destinatarios = [...new Set([boleto.gerente_email, boleto.vendedor_email]
        .filter(email => typeof email === 'string' && email.trim() !== '')
        .map(email => email.trim()))];
    if (destinatarios.length === 0) {
        const error = new Error('O gerente e o vendedor não possuem e-mail cadastrado.');
        error.status = 400;
        throw error;
    }

    const titulosRes = await executor.query(`
        SELECT b2.data_vencimento, b2.numero_documento, b2.valor_original,
               b2.status_cobranca, cl2.nome AS cliente_nome,
               cl2.nome_fantasia AS cliente_nome_fantasia
        FROM boletos b2
        LEFT JOIN clientes cl2 ON cl2.id = b2.cliente_id
        WHERE b2.id <> $1
          AND b2.excluido_em IS NULL
          AND b2.situacao_boleto IN ('Vencido', 'Pago com Pendência')
          AND (
              ($2::integer IS NOT NULL AND b2.cliente_id = $2)
              OR (
                  NULLIF(regexp_replace(COALESCE($3, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
                  AND regexp_replace(COALESCE(cl2.cnpj_cpf, ''), '[^0-9]', '', 'g') =
                      regexp_replace($3, '[^0-9]', '', 'g')
              )
          )
        ORDER BY b2.data_vencimento ASC, b2.id ASC
    `, [boleto.id, boleto.cliente_id, boleto.cliente_cnpj]);

    const clienteNome = boleto.cliente_nome || 'Cliente';
    const nomeFantasia = boleto.cliente_nome_fantasia || '';
    const assunto = boleto.situacao_boleto === 'Pago'
        ? `AVISO DE LIQUIDAÇÃO: Cliente ${clienteNome} - Boleto Nº ${boleto.numero_documento}`
        : `PENDÊNCIA DE CUSTAS: Cliente ${clienteNome} - Boleto Nº ${boleto.numero_documento}`;
    const corpo = boleto.situacao_boleto === 'Pago'
        ? `Prezados Gerente e Vendedor,

O boleto Nº ${boleto.numero_documento} referente ao cliente ${clienteNome} foi liquidado.

${titulosRes.rows.length === 0
        ? 'O cliente está com o extrato totalmente quitado e o cadastro está liberado para novos pedidos no sistema.'
        : `O cliente ainda possui os seguintes títulos em aberto:\n\n${titulosRes.rows.map(titulo => `- Vencimento: ${formatarDataEmail(titulo.data_vencimento)} | Nº do Documento: ${titulo.numero_documento || 'Não informado'} | Razão Social: ${titulo.cliente_nome || 'Não informada'} | Nome Fantasia: ${titulo.cliente_nome_fantasia || 'Não informado'} | Valor Original: R$ ${formatarMoedaSemSimbolo(titulo.valor_original)} | Fase da Régua: ${titulo.status_cobranca || 'Aguardando Régua'}`).join('\n')}`}

Atenciosamente,
Setor Financeiro - Omnia`
        : `Prezados Gerente e Vendedor,

O boleto Nº ${boleto.numero_documento} referente ao cliente ${clienteNome}${nomeFantasia ? ` (${nomeFantasia})` : ''} foi pago, porém possui pendência de custas bancárias/cartório no valor de R$ ${formatarMoedaSemSimbolo(boleto.valor_custas)}.

${titulosRes.rows.length === 0
        ? 'O cliente está com o extrato totalmente quitado, exceto pela pendência de custas deste boleto.'
        : `O cliente ainda possui os seguintes títulos em aberto:\n\n${titulosRes.rows.map(titulo => `- Vencimento: ${formatarDataEmail(titulo.data_vencimento)} | Nº do Documento: ${titulo.numero_documento || 'Não informado'} | Razão Social: ${titulo.cliente_nome || 'Não informada'} | Nome Fantasia: ${titulo.cliente_nome_fantasia || 'Não informado'} | Valor Original: R$ ${formatarMoedaSemSimbolo(titulo.valor_original)} | Fase da Régua: ${titulo.status_cobranca || 'Aguardando Régua'}`).join('\n')}`}

Informamos que novos pedidos permanecerão bloqueados até a quitação integral destas custas.

Atenciosamente,
Setor Financeiro - Omnia`;

    return {
        boleto,
        para: destinatarios.join(','),
        assunto,
        corpo,
        contatoNome: nomeFantasia ? `${clienteNome} (${nomeFantasia})` : clienteNome
    };
}

app.post('/cobranca/email-liquidacao/preparar/:id', verificarAutenticacao, async (req, res) => {
    const boletoId = Number(req.params.id);
    if (!Number.isSafeInteger(boletoId) || boletoId <= 0) {
        return res.status(400).json({ erro: 'Identificador do boleto inválido.' });
    }

    try {
        const email = await carregarEmailAvisoComercial(boletoId);
        if (!email) return res.status(404).json({ erro: 'Boleto não encontrado.' });
        res.json({ para: email.para, assunto: email.assunto, corpo: email.corpo });
    } catch (err) {
        if (err.status === 400) return res.status(400).json({ erro: err.message });
        console.error('ERRO AO PREPARAR AVISO DE LIQUIDAÇÃO:', err);
        res.status(500).json({ erro: 'Erro ao preparar o aviso de liquidação.' });
    }
});

app.post('/cobranca/email-liquidacao/confirmar/:id', verificarAutenticacao, async (req, res) => {
    const boletoId = Number(req.params.id);
    if (!Number.isSafeInteger(boletoId) || boletoId <= 0) {
        return res.status(400).json({ erro: 'Identificador do boleto inválido.' });
    }

    let db;
    let transactionStarted = false;
    try {
        db = await pool.connect();
        await db.query('BEGIN');
        transactionStarted = true;
        const boletoRes = await db.query(`
            SELECT cl.nome AS cliente_nome, cl.nome_fantasia AS cliente_nome_fantasia
            FROM boletos b
            LEFT JOIN clientes cl ON cl.id = b.cliente_id
            WHERE b.id = $1 AND b.excluido_em IS NULL
        `, [boletoId]);
        if (boletoRes.rows.length === 0) {
            await db.query('ROLLBACK');
            transactionStarted = false;
            return res.status(404).json({ erro: 'Boleto não encontrado.' });
        }

        const { para, assunto, corpo } = req.body;
        if ([para, assunto, corpo].some(valor => typeof valor !== 'string' || valor.trim() === '')) {
            await db.query('ROLLBACK');
            transactionStarted = false;
            return res.status(400).json({ erro: 'Conteúdo do aviso de liquidação inválido.' });
        }
        const resumo = `Aviso de liquidação/pagamento enviado para gerente e vendedor (${para.trim()}). Assunto: ${assunto.trim()}.\n\n${corpo.trim()}`;
        const clienteNome = boletoRes.rows[0].cliente_nome || 'Cliente';
        const contatoNome = boletoRes.rows[0].cliente_nome_fantasia
            ? `${clienteNome} (${boletoRes.rows[0].cliente_nome_fantasia})`
            : clienteNome;
        const historicoRes = await db.query(`
            INSERT INTO boletos_historico
                (boleto_id, usuario_id, tipo_contato, canal, contato_nome, resumo, status, data_hora)
            VALUES ($1, $2, 'Interno', 'E-mail', $3, $4, 'Confirmado', CURRENT_TIMESTAMP)
            RETURNING id, data_hora
        `, [boletoId, req.session.usuario.id, contatoNome, resumo]);
        await db.query('COMMIT');
        transactionStarted = false;

        res.json({
            sucesso: 'Aviso de liquidação confirmado e registrado no histórico.',
            interacao: {
                id: historicoRes.rows[0].id,
                data_hora: historicoRes.rows[0].data_hora,
                tipo_contato: 'Interno',
                canal: 'E-mail',
                contato_nome: contatoNome,
                resumo,
                status: 'Confirmado',
                usuario_nome: req.session.usuario.nome || 'Usuário atual'
            }
        });
    } catch (err) {
        if (db && transactionStarted) {
            try {
                await db.query('ROLLBACK');
            } catch (rollbackErr) {
                console.error('ERRO AO DESFAZER REGISTRO DO AVISO DE LIQUIDAÇÃO:', rollbackErr);
            }
        }
        if (err.status === 400) return res.status(400).json({ erro: err.message });
        console.error('ERRO AO CONFIRMAR AVISO DE LIQUIDAÇÃO:', err);
        res.status(500).json({ erro: 'Erro ao registrar o aviso de liquidação no histórico.' });
    } finally {
        if (db) db.release();
    }
});

async function carregarEmailRegua(boletoId, etapa, executor = pool) {
    const boletoRes = await executor.query(`
        SELECT b.id, b.cliente_id, b.numero_documento, b.data_vencimento, b.valor_original,
               b.status_cobranca, b.situacao_boleto,
               cl.cnpj_cpf AS cliente_cnpj, cl.nome, cl.nome_fantasia, cl.email,
               g.email AS gerente_email, v.email AS vendedor_email
        FROM boletos b
        LEFT JOIN clientes cl ON cl.id = b.cliente_id
        LEFT JOIN vendedores v ON v.id = COALESCE(b.vendedor_id, cl.vendedor_id)
        LEFT JOIN gerentes g ON g.id = COALESCE(b.gerente_id, cl.gerente_id, v.gerente_id)
        WHERE b.id = $1 AND b.excluido_em IS NULL
    `, [boletoId]);

    if (boletoRes.rows.length === 0) return null;

    const boleto = boletoRes.rows[0];
    const para = boleto.email ? boleto.email.trim() : '';
    if (!para) {
        const error = new Error('O cliente não possui e-mail cadastrado.');
        error.status = 400;
        throw error;
    }

    const cc = [...new Set([boleto.gerente_email, boleto.vendedor_email]
        .filter(value => typeof value === 'string' && value.trim() !== '')
        .map(value => value.trim()))];
    const razaoSocial = boleto.nome ? boleto.nome.trim() : '';
    const nomeFantasia = boleto.nome_fantasia ? boleto.nome_fantasia.trim() : '';
    const clienteNome = razaoSocial
        ? (nomeFantasia ? `${razaoSocial} (${nomeFantasia})` : razaoSocial)
        : (nomeFantasia || 'Cliente');
    const vencimento = boleto.data_vencimento
        ? new Date(boleto.data_vencimento).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
        : 'Não informado';
    const identificacaoTitulo = `**Vencimento: ${vencimento} - Doc: ${boleto.numero_documento} - ${clienteNome} - R$ ${formatarMoedaSemSimbolo(boleto.valor_original)}**`;
    const outrosTitulosRes = await executor.query(`
        SELECT b2.data_vencimento, b2.numero_documento, b2.valor_original, b2.status_cobranca
        FROM boletos b2
        LEFT JOIN clientes cl2 ON cl2.id = b2.cliente_id
        WHERE b2.id <> $1
          AND b2.excluido_em IS NULL
          AND b2.situacao_boleto IN ('Vencido', 'Pago com Pendência')
          AND (
              ($2::integer IS NOT NULL AND b2.cliente_id = $2)
              OR (
                  NULLIF(regexp_replace(COALESCE($3, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
                  AND regexp_replace(COALESCE(cl2.cnpj_cpf, ''), '[^0-9]', '', 'g') =
                      regexp_replace($3, '[^0-9]', '', 'g')
              )
          )
        ORDER BY b2.data_vencimento ASC, b2.id ASC
    `, [boleto.id, boleto.cliente_id, boleto.cliente_cnpj]);
    const outrosTitulos = outrosTitulosRes.rows;
    const listaOutrosTitulos = outrosTitulos.map(titulo => {
        const situacaoCartorio = titulo.status_cobranca === 'Em Cartório / Negativado'
            ? ' *(Situação: Em Cartório / Negativado)*'
            : '';
        return `- Vencimento: ${formatarDataEmail(titulo.data_vencimento)} | Nº do Documento: ${titulo.numero_documento || 'Não informado'} | Valor Original: R$ ${formatarMoedaSemSimbolo(titulo.valor_original)}${situacaoCartorio}`;
    }).join('\n');
    const blocoOutrosTitulos = outrosTitulos.length > 0
        ? `Faturas vencidas adicionais em aberto:\n${listaOutrosTitulos}`
        : '';
    const etapaConfig = etapasEmailRegua[etapa];
    let assunto;
    let corpo;

    if (etapa === 1) {
        assunto = `1º E-mail (Aviso 1) - Boleto Nº ${boleto.numero_documento}`;
        corpo = `Prezado cliente,

Esperamos que este e-mail o(a) encontre bem.

Estamos entrando em contato para informar que, em nosso sistema, consta como em aberto o título:

${identificacaoTitulo}

${blocoOutrosTitulos ? `${blocoOutrosTitulos}\n\n` : ''}Se o pagamento já foi efetuado, por favor, nos avise e nos envie o comprovante para que possamos dar baixa em nosso registro.

Caso precise de qualquer informação para regularizar a situação, ou se houver alguma dúvida, estamos à disposição para ajudar. Você pode nos contatar em 11 4486-8977 ou responder a este e-mail.

Agradecemos a sua atenção e colaboração.

Atenciosamente,`;
    } else if (etapa === 2) {
        assunto = `RE: Lembrete de Cobrança - Boleto Nº ${boleto.numero_documento}`;
        corpo = `Prezado(a) cliente,

Esperamos que este e-mail o(a) encontre bem.

Estamos enviando este segundo aviso para reforçar nosso contato anterior, referente ao título que em nosso sistema ainda consta como em aberto:

${identificacaoTitulo}

${blocoOutrosTitulos ? `Além do título acima, lembramos que também constam as seguintes faturas vencidas acumuladas:\n${listaOutrosTitulos}\n\n` : ''}Se o pagamento já foi efetuado, pedimos a gentileza de nos enviar o comprovante para que possamos atualizar o status em nosso sistema e evitar futuros lembretes.

Caso haja alguma dificuldade para regularizar essa pendência, ou se precisar de qualquer informação adicional, por favor, entre em contato conosco o mais breve possível. Estamos à disposição para ajudar.

Agradecemos a sua atenção e colaboração.

Atenciosamente,`;
    } else {
        assunto = `URGENTE: Notificação Final de Envio a Cartório - Boleto Nº ${boleto.numero_documento}`;
        corpo = `Prezado(a) cliente,

Esperamos que este e-mail o(a) encontre bem.

Estamos enviando este último aviso referente ao título que continua em aberto em nosso sistema:

${identificacaoTitulo}

Apesar de nossos avisos anteriores o pagamento ainda não foi regularizado.

${outrosTitulos.length > 0
        ? `Todos os títulos vencidos e não pagos relacionados serão cobrados em conjunto, incluindo o título acima e as seguintes faturas adicionais:\n${listaOutrosTitulos}\n\n`
        : 'Todos os títulos vencidos e não pagos relacionados serão cobrados em conjunto, caso existam outros títulos em aberto além do título acima.\n\n'}Informamos que, na ausência de regularização, este título será encaminhado para protesto em cartório no próximo dia útil. O protesto pode acarretar custos adicionais e restrições de crédito para sua empresa/CPF.

Caso o pagamento já tenha sido efetuado, por favor, nos envie o comprovante com urgência para que possamos evitar o protesto e atualizar nosso sistema.

Estamos à disposição para qualquer esclarecimento final e para auxiliá-lo(a) na regularização imediata. Por favor, entre em contato respondendo a este e-mail.

Agradecemos sua atenção e compreensão.

Atenciosamente,`;
    }

    return { para, cc, assunto, corpo, clienteNome, etapaConfig };
}

app.post('/cobranca/email-regua/preparar/:id', verificarAutenticacao, async (req, res) => {
    const boletoId = Number(req.params.id);
    const etapa = Number(req.body.etapa);
    if (!Number.isSafeInteger(boletoId) || boletoId <= 0 || !etapasEmailRegua[etapa]) {
        return res.status(400).json({ erro: 'Boleto ou etapa da régua inválida.' });
    }

    try {
        const email = await carregarEmailRegua(boletoId, etapa);
        if (!email) return res.status(404).json({ erro: 'Boleto não encontrado.' });
        if (email.status_cobranca !== email.etapaConfig.faseAnterior ||
            !['Vencido', 'Pago com Pendência'].includes(email.situacao_boleto)) {
            return res.status(409).json({ erro: 'A etapa não corresponde à fase atual ou o boleto não está em aberto.' });
        }
        res.json({ ...email, etapa, fase: email.etapaConfig.fase });
    } catch (err) {
        if (err.status === 400) return res.status(400).json({ erro: err.message });
        console.error('ERRO AO PREPARAR E-MAIL DA RÉGUA:', err);
        res.status(500).json({ erro: 'Erro ao preparar o e-mail.' });
    }
});

app.post('/cobranca/email-regua/confirmar/:id', verificarAutenticacao, async (req, res) => {
    const boletoId = Number(req.params.id);
    const etapa = Number(req.body.etapa);
    if (!Number.isSafeInteger(boletoId) || boletoId <= 0 || !etapasEmailRegua[etapa]) {
        return res.status(400).json({ erro: 'Boleto ou etapa da régua inválida.' });
    }
    const { para, cc, assunto, corpo } = req.body;
    if ([para, cc, assunto, corpo].some(valor => typeof valor !== 'string') ||
        !para.trim() || !assunto.trim() || !corpo.trim()) {
        return res.status(400).json({ erro: 'Conteúdo do e-mail enviado inválido.' });
    }

    let db;
    let transactionStarted = false;
    try {
        db = await pool.connect();
        const email = await carregarEmailRegua(boletoId, etapa, db);
        if (!email) {
            return res.status(404).json({ erro: 'Boleto não encontrado.' });
        }
        if (email.status_cobranca !== email.etapaConfig.faseAnterior ||
            !['Vencido', 'Pago com Pendência'].includes(email.situacao_boleto)) {
            return res.status(409).json({ erro: 'A etapa não corresponde à fase atual ou o boleto não está em aberto.' });
        }

        await db.query('BEGIN');
        transactionStarted = true;
        const updateRes = await db.query(
            `UPDATE boletos
             SET status_cobranca = $1, data_fase_cobranca = CURRENT_TIMESTAMP,
                 atualizado_em = CURRENT_TIMESTAMP
             WHERE id = $2 AND excluido_em IS NULL AND status_cobranca = $3`,
            [email.etapaConfig.fase, boletoId, email.etapaConfig.faseAnterior]
        );
        if (updateRes.rowCount === 0) {
            await db.query('ROLLBACK');
            transactionStarted = false;
            return res.status(409).json({ erro: 'A fase do boleto mudou. Atualize a página antes de confirmar o envio.' });
        }
        await db.query(`
            UPDATE boletos_regua_pendencias
            SET status = 'Concluida', concluido_em = CURRENT_TIMESTAMP,
                concluido_por = $3
            WHERE boleto_id = $1 AND etapa = $2 AND status = 'Pendente'
        `, [boletoId, etapa, req.session.usuario.id]);

        const resumo = `Status: Confirmado. Envio da etapa ${etapa} (${email.etapaConfig.fase}) confirmado pelo usuário. Para: ${para.trim()}. CC: ${cc.trim() || 'Nenhum'}. Assunto: ${assunto.trim()}\n\n${corpo.trim()}`;
        const historicoRes = await db.query(`
            INSERT INTO boletos_historico
                (boleto_id, usuario_id, tipo_contato, canal, contato_nome, resumo, status, data_hora)
            VALUES ($1, $2, 'Cliente', 'E-mail', $3, $4, 'Confirmado', CURRENT_TIMESTAMP)
            RETURNING id, data_hora
        `, [boletoId, req.session.usuario.id, email.clienteNome, resumo]);
        await db.query('COMMIT');
        transactionStarted = false;

        res.json({
            sucesso: 'Envio confirmado e registrado no histórico.',
            fase: email.etapaConfig.fase,
            interacao: {
                id: historicoRes.rows[0].id,
                data_hora: historicoRes.rows[0].data_hora,
                tipo_contato: 'Cliente',
                canal: 'E-mail',
                contato_nome: email.clienteNome,
                resumo,
                status: 'Confirmado',
                usuario_nome: req.session.usuario.nome || 'Usuário atual'
            }
        });
    } catch (err) {
        if (db && transactionStarted) {
            try {
                await db.query('ROLLBACK');
            } catch (rollbackErr) {
                console.error('ERRO AO DESFAZER CONFIRMAÇÃO DE E-MAIL:', rollbackErr);
            }
        }
        if (err.status === 400) return res.status(400).json({ erro: err.message });
        console.error('ERRO AO CONFIRMAR E-MAIL DA RÉGUA:', err);
        res.status(500).json({ erro: 'Erro ao confirmar o envio e atualizar a fase da régua.' });
    } finally {
        if (db) db.release();
    }
});

// REGISTRAR HISTÓRICO DE INTERAÇÃO (FONE, WHATSAPP, E-MAIL)
app.post('/cobranca/historico/novo/:id', verificarAutenticacao, async (req, res) => {
    const boletoId = req.params.id;
    const { tipo_contato, canal, contato_nome, resumo } = req.body;

    try {
        const sql = `INSERT INTO boletos_historico (boleto_id, usuario_id, tipo_contato, canal, contato_nome, resumo, status, data_hora)
                     VALUES ($1, $2, $3, $4, $5, $6, 'Registrado', CURRENT_TIMESTAMP)`;
        
        await pool.query(sql, [
            parseInt(boletoId, 10),
            req.session.usuario.id,
            tipo_contato,
            canal,
            formatarCapitalizacao(contato_nome),
            formatarCapitalizacao(resumo)
        ]);

        res.redirect(`/cobranca/editar/${boletoId}?sucesso=Histórico registrado com sucesso!`);
    } catch (err) {
        console.error('ERRO AO GRAVAR HISTÓRICO:', err);
        res.redirect(`/cobranca/editar/${boletoId}?erro=Erro ao gravar histórico.`);
    }
});

app.post('/cobranca/historico/editar/:boletoId/:historicoId', verificarAutenticacao, async (req, res) => {
    const boletoId = Number(req.params.boletoId);
    const historicoId = Number(req.params.historicoId);
    const { tipo_contato, canal, contato_nome, resumo } = req.body;
    if (!Number.isSafeInteger(boletoId) || boletoId <= 0 || !Number.isSafeInteger(historicoId) || historicoId <= 0) {
        return res.redirect('/cobranca?erro=Identificador de histórico inválido.');
    }
    if (!tipo_contato || !canal || !resumo || !String(resumo).trim()) {
        return res.redirect(`/cobranca/editar/${boletoId}?erro=Preencha os dados da interação.`);
    }

    try {
        const result = await pool.query(`
            UPDATE boletos_historico
            SET tipo_contato = $1, canal = $2, contato_nome = $3, resumo = $4
            WHERE id = $5 AND boleto_id = $6 AND excluido_em IS NULL
        `, [
            tipo_contato,
            canal,
            formatarCapitalizacao(contato_nome),
            String(resumo).trim(),
            historicoId,
            boletoId
        ]);
        if (result.rowCount === 0) {
            return res.redirect(`/cobranca/editar/${boletoId}?erro=Interação não encontrada.`);
        }
        res.redirect(`/cobranca/editar/${boletoId}?sucesso=Interação atualizada com sucesso.`);
    } catch (err) {
        console.error('ERRO AO EDITAR HISTÓRICO DA COBRANÇA:', err);
        res.redirect(`/cobranca/editar/${boletoId}?erro=Erro ao atualizar interação.`);
    }
});

app.post('/cobranca/historico/excluir/:boletoId/:id', verificarAutenticacao, async (req, res) => {
    const boletoId = Number(req.params.boletoId);
    const historicoId = Number(req.params.id);
    if (!Number.isSafeInteger(boletoId) || boletoId <= 0 || !Number.isSafeInteger(historicoId) || historicoId <= 0) {
        return res.redirect('/cobranca?erro=Identificador de histórico inválido.');
    }

    try {
        const result = await pool.query(
            `UPDATE boletos_historico
             SET excluido_em = CURRENT_TIMESTAMP, excluido_por = $3,
                 motivo_exclusao = 'Exclusão solicitada pelo usuário'
             WHERE boleto_id = $1 AND id = $2 AND excluido_em IS NULL`,
            [boletoId, historicoId, req.session.usuario.id]
        );
        if (result.rowCount === 0) {
            return res.redirect(`/cobranca/editar/${boletoId}?erro=Interação não encontrada.`);
        }
        res.redirect(`/cobranca/editar/${boletoId}?sucesso=Interação excluída com sucesso.`);
    } catch (err) {
        console.error('ERRO AO EXCLUIR HISTÓRICO DA COBRANÇA:', err);
        res.redirect(`/cobranca/editar/${boletoId}?erro=Erro ao excluir interação.`);
    }
});

// ROTA PARA REGISTAR FALHA NA ENTREGA DE E-MAIL NO HISTÓRICO
app.post('/cobranca/email-falha/:id', verificarAutenticacao, async (req, res) => {
    const boletoId = Number(req.params.id);
    if (!Number.isSafeInteger(boletoId) || boletoId <= 0) {
        return res.status(400).json({ erro: 'Identificador do boleto inválido.' });
    }

    try {
        const boletoRes = await pool.query(`
            SELECT b.numero_documento, cl.nome, cl.email,
                   g.email AS gerente_email, v.email AS vendedor_email
            FROM boletos b
            LEFT JOIN clientes cl ON cl.id = b.cliente_id
            LEFT JOIN vendedores v ON v.id = COALESCE(b.vendedor_id, cl.vendedor_id)
            LEFT JOIN gerentes g ON g.id = COALESCE(b.gerente_id, cl.gerente_id, v.gerente_id)
            WHERE b.id = $1 AND b.excluido_em IS NULL
        `, [boletoId]);

        if (boletoRes.rows.length === 0) {
            return res.status(404).json({ erro: 'Boleto não encontrado.' });
        }

        const boleto = boletoRes.rows[0];
        const emailAtual = boleto.email || 'Não informado';
        const destinatarios = [...new Set([boleto.gerente_email, boleto.vendedor_email]
            .filter(email => typeof email === 'string' && email.trim() !== '')
            .map(email => email.trim()))];
        if (destinatarios.length === 0) {
            return res.status(400).json({ erro: 'O gerente e o vendedor não possuem e-mail cadastrado.' });
        }

        const assunto = `FALHA NA ENTREGA DE E-MAIL: Cliente ${boleto.nome || 'Cliente'} - Boleto Nº ${boleto.numero_documento}`;
        const corpo = `Prezados Gerente e Vendedor,

Informamos que o e-mail de cobrança enviado para o cliente ${boleto.nome || 'Cliente'} através do endereço (${emailAtual}) retornou ou não pôde ser entregue (endereço incorreto ou caixa postal cheia).

Precisamos que por favor verifiquem e nos informem o e-mail correto do cliente para atualizarmos o cadastro, ou que entrem em contato diretamente com ele para alertá-lo sobre a cobrança em aberto do boleto Nº ${boleto.numero_documento}.

Contamos com a vossa colaboração.

Atenciosamente,
Setor Financeiro - Omnia`;
        const resumo = `Aviso de falha na entrega de e-mail preparado para gerente e vendedor (${destinatarios.join(', ')}). E-mail cadastrado do cliente: ${emailAtual}.

${corpo}`;

        await pool.query(`
            INSERT INTO boletos_historico
                (boleto_id, usuario_id, tipo_contato, canal, contato_nome, resumo, status, data_hora)
            VALUES ($1, $2, 'Interno', 'E-mail', 'Gerente e Vendedor', $3, 'Registrado', CURRENT_TIMESTAMP)
        `, [boletoId, req.session.usuario.id, resumo]);

        res.json({ sucesso: 'Aviso de falha registado no histórico com sucesso.', para: destinatarios.join(','), assunto, corpo });
    } catch (err) {
        console.error('ERRO AO REGISTRAR FALHA DE E-MAIL:', err);
        res.status(500).json({ erro: 'Erro ao registrar falha no histórico.' });
    }
});

// EXCLUIR BOLETO
app.post('/cobranca/excluir/:id', verificarAutenticacao, async (req, res) => {
    const motivo = typeof req.body.motivo_exclusao === 'string' ? req.body.motivo_exclusao.trim() : '';
    if (!motivo) {
        return res.redirect(`/cobranca?erro=${encodeURIComponent('Informe o motivo da exclusão do boleto.')}`);
    }
    try {
        const result = await pool.query(`
            UPDATE boletos
            SET excluido_em = CURRENT_TIMESTAMP, excluido_por = $2,
                motivo_exclusao = $3, atualizado_em = CURRENT_TIMESTAMP
            WHERE id = $1 AND excluido_em IS NULL
        `, [req.params.id, req.session.usuario.id, motivo]);
        res.redirect(result.rowCount
            ? '/cobranca?sucesso=Boleto arquivado com sucesso.'
            : '/cobranca?erro=Boleto não encontrado ou já arquivado.');
    } catch (err) {
        console.error('ERRO AO EXCLUIR BOLETO:', err);
        res.redirect('/cobranca?erro=Erro ao excluir boleto.');
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