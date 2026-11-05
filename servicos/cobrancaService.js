async function sincronizarPendenciasRegua(pool, usuarioId) {
    if (!Number.isSafeInteger(Number(usuarioId)) || Number(usuarioId) <= 0) {
        throw new TypeError('É necessário um utilizador autenticado para auditar a régua de cobrança.');
    }

    const db = await pool.connect();
    try {
        await db.query('BEGIN');

        const canceladas = await db.query(`
            UPDATE boletos_regua_pendencias AS pendencia
            SET status = 'Cancelada', concluido_em = CURRENT_TIMESTAMP,
                concluido_por = $1
            WHERE pendencia.status = 'Pendente'
              AND NOT EXISTS (
                  SELECT 1
                  FROM boletos b
                  WHERE b.id = pendencia.boleto_id
                    AND b.excluido_em IS NULL
                    AND b.situacao_boleto IN ('Vencido', 'Pago com Pendência')
                    AND b.status_cobranca = pendencia.fase_origem
                    AND b.data_fase_cobranca = pendencia.data_fase_origem
              )
            RETURNING pendencia.boleto_id, pendencia.acao
        `, [Number(usuarioId)]);

        if (canceladas.rowCount > 0) {
            await db.query(`
                INSERT INTO boletos_historico
                    (boleto_id, usuario_id, tipo_contato, canal, contato_nome, resumo, status, data_hora)
                SELECT boleto_id, $1, 'Interno', 'Sistema', 'Régua automática',
                       'Ação pendente cancelada porque a fase do boleto mudou ou deixou de estar em aberto. Ação: ' || acao,
                       'Cancelada', CURRENT_TIMESTAMP
                FROM UNNEST($2::integer[], $3::text[]) AS canceladas(boleto_id, acao)
            `, [
                Number(usuarioId),
                canceladas.rows.map(row => row.boleto_id),
                canceladas.rows.map(row => row.acao)
            ]);
        }

        const criadas = await db.query(`
            WITH candidatos AS (
                SELECT b.id AS boleto_id, 1::smallint AS etapa,
                       'Aguardando Régua'::text AS fase_origem,
                       'Aviso 1 (Notificação)'::text AS acao,
                       b.data_fase_cobranca AS data_fase_origem,
                       prazo.data_acao
                FROM boletos b
                CROSS JOIN LATERAL (
                    SELECT dia::date AS data_acao
                    FROM generate_series(
                        (b.data_vencimento + 1)::timestamp,
                        (b.data_vencimento + 30)::timestamp,
                        INTERVAL '1 day'
                    ) AS calendario(dia)
                    WHERE EXTRACT(ISODOW FROM dia) BETWEEN 1 AND 5
                      AND NOT omnia_is_feriado_bancario(dia::date)
                    ORDER BY dia
                    LIMIT 1
                ) prazo
                WHERE b.excluido_em IS NULL
                  AND b.situacao_boleto IN ('Vencido', 'Pago com Pendência')
                  AND b.status_cobranca = 'Aguardando Régua'

                UNION ALL

                SELECT b.id, 2::smallint, 'Aviso 1 (Notificação)'::text,
                       'Aviso 2 (Alerta Cartório)'::text,
                       b.data_fase_cobranca, prazo.data_acao
                FROM boletos b
                CROSS JOIN LATERAL (
                    SELECT dia::date AS data_acao
                    FROM generate_series(
                        (b.data_fase_cobranca::date + 1)::timestamp,
                        (b.data_fase_cobranca::date + 30)::timestamp,
                        INTERVAL '1 day'
                    ) AS calendario(dia)
                    WHERE EXTRACT(ISODOW FROM dia) BETWEEN 1 AND 5
                      AND NOT omnia_is_feriado_bancario(dia::date)
                    ORDER BY dia
                    OFFSET 1 LIMIT 1
                ) prazo
                WHERE b.excluido_em IS NULL
                  AND b.situacao_boleto IN ('Vencido', 'Pago com Pendência')
                  AND b.status_cobranca = 'Aviso 1 (Notificação)'

                UNION ALL

                SELECT b.id, 3::smallint, 'Aviso 2 (Alerta Cartório)'::text,
                       'Aviso 3 (Aviso Final)'::text,
                       b.data_fase_cobranca, prazo.data_acao
                FROM boletos b
                CROSS JOIN LATERAL (
                    SELECT dia::date AS data_acao
                    FROM generate_series(
                        (b.data_fase_cobranca::date + 1)::timestamp,
                        (b.data_fase_cobranca::date + 30)::timestamp,
                        INTERVAL '1 day'
                    ) AS calendario(dia)
                    WHERE EXTRACT(ISODOW FROM dia) BETWEEN 1 AND 5
                      AND NOT omnia_is_feriado_bancario(dia::date)
                    ORDER BY dia
                    OFFSET 1 LIMIT 1
                ) prazo
                WHERE b.excluido_em IS NULL
                  AND b.situacao_boleto IN ('Vencido', 'Pago com Pendência')
                  AND b.status_cobranca = 'Aviso 2 (Alerta Cartório)'

                UNION ALL

                SELECT b.id, 4::smallint, 'Aviso 3 (Aviso Final)'::text,
                       'Encaminhamento ao Cartório'::text,
                       b.data_fase_cobranca, prazo.data_acao
                FROM boletos b
                CROSS JOIN LATERAL (
                    SELECT dia::date AS data_acao
                    FROM generate_series(
                        (b.data_fase_cobranca::date + 1)::timestamp,
                        (b.data_fase_cobranca::date + 30)::timestamp,
                        INTERVAL '1 day'
                    ) AS calendario(dia)
                    WHERE EXTRACT(ISODOW FROM dia) BETWEEN 1 AND 5
                      AND NOT omnia_is_feriado_bancario(dia::date)
                    ORDER BY dia
                    LIMIT 1
                ) prazo
                WHERE b.excluido_em IS NULL
                  AND b.situacao_boleto IN ('Vencido', 'Pago com Pendência')
                  AND b.status_cobranca = 'Aviso 3 (Aviso Final)'
            ),
            novas AS (
                INSERT INTO boletos_regua_pendencias AS pendencia
                    (boleto_id, etapa, fase_origem, acao, data_fase_origem,
                     data_acao, status, criado_por)
                SELECT boleto_id, etapa, fase_origem, acao, data_fase_origem,
                       data_acao, 'Pendente', $1
                FROM candidatos
                WHERE data_acao <= CURRENT_DATE
                ON CONFLICT ON CONSTRAINT uq_boleto_etapa_pendente
                DO NOTHING
                RETURNING boleto_id, etapa, acao, data_acao
            ),
            historico AS (
                INSERT INTO boletos_historico
                    (boleto_id, usuario_id, tipo_contato, canal, contato_nome, resumo, status, data_hora)
                SELECT boleto_id, $1, 'Interno', 'Sistema', 'Régua automática',
                       'Prazo atingido para ' || acao || ' em ' ||
                           TO_CHAR(data_acao, 'DD/MM/YYYY') ||
                           '. Ação pendente de envio/execução pelo responsável.',
                       'Pendente', CURRENT_TIMESTAMP
                FROM novas
                RETURNING id
            )
            SELECT novas.boleto_id
            FROM novas
            CROSS JOIN (SELECT COUNT(*) FROM historico) AS registro
        `, [Number(usuarioId)]);

        await db.query('COMMIT');
        return {
            criadas: criadas.rowCount,
            canceladas: canceladas.rowCount
        };
    } catch (err) {
        try {
            await db.query('ROLLBACK');
        } catch (rollbackErr) {
            console.error('ERRO AO DESFAZER SINCRONIZAÇÃO DA RÉGUA:', rollbackErr);
        }
        throw err;
    } finally {
        db.release();
    }
}

module.exports = { sincronizarPendenciasRegua };
