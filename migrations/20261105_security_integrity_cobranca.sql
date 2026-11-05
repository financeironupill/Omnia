BEGIN;

ALTER TABLE boletos
    ADD COLUMN IF NOT EXISTS excluido_em TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS excluido_por INTEGER,
    ADD COLUMN IF NOT EXISTS motivo_exclusao TEXT,
    ADD COLUMN IF NOT EXISTS data_fase_cobranca TIMESTAMPTZ;

ALTER TABLE boletos_historico
    ADD COLUMN IF NOT EXISTS excluido_em TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS excluido_por INTEGER,
    ADD COLUMN IF NOT EXISTS motivo_exclusao TEXT;

UPDATE boletos
SET data_fase_cobranca = COALESCE(atualizado_em, criado_em, CURRENT_TIMESTAMP)
WHERE data_fase_cobranca IS NULL;

ALTER TABLE boletos
    ALTER COLUMN data_fase_cobranca SET DEFAULT CURRENT_TIMESTAMP;

-- Computa feriados bancários nacionais e datas móveis sem manter listas anuais.
CREATE OR REPLACE FUNCTION omnia_is_feriado_bancario(data_consulta DATE)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
    WITH ano AS (
        SELECT EXTRACT(YEAR FROM data_consulta)::INTEGER AS y
    ),
    calculo AS (
        SELECT y, y % 19 AS a, y / 100 AS b, y % 100 AS c
        FROM ano
    ),
    partes AS (
        SELECT *,
               b / 4 AS d, b % 4 AS e, (b + 8) / 25 AS f,
               (b - (b + 8) / 25 + 1) / 3 AS g,
               c / 4 AS i, c % 4 AS k
        FROM calculo
    ),
    pascoa_a AS (
        SELECT *, MOD(19 * a + b - d - g + 15, 30) AS h
        FROM partes
    ),
    pascoa_b AS (
        SELECT *, MOD(32 + 2 * e + 2 * i - h - k, 7) AS l
        FROM pascoa_a
    ),
    pascoa_c AS (
        SELECT *, (a + 11 * h + 22 * l) / 451 AS m
        FROM pascoa_b
    ),
    pascoa AS (
        SELECT y,
               make_date(
                   y,
                   (h + l - 7 * m + 114) / 31,
                   MOD(h + l - 7 * m + 114, 31) + 1
               ) AS domingo_pascal
        FROM pascoa_c
    )
    SELECT COALESCE(BOOL_OR(feriado = data_consulta), FALSE)
    FROM pascoa
    CROSS JOIN LATERAL (
        VALUES
            (make_date(y, 1, 1)),
            (domingo_pascal - 48),
            (domingo_pascal - 47),
            (domingo_pascal - 2),
            (domingo_pascal + 60),
            (make_date(y, 4, 21)),
            (make_date(y, 5, 1)),
            (make_date(y, 9, 7)),
            (make_date(y, 10, 12)),
            (make_date(y, 11, 2)),
            (make_date(y, 11, 15)),
            (CASE WHEN y >= 2024 THEN make_date(y, 11, 20) ELSE NULL::DATE END),
            (make_date(y, 12, 25))
    ) AS calendario(feriado)
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM boletos
        GROUP BY cliente_id, UPPER(numero_documento)
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Migração cancelada: há números de documento duplicados por cliente. Nenhum registro foi removido; saneie as duplicidades antes de reaplicar.';
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_boletos_cliente_documento_upper
    ON boletos (cliente_id, UPPER(numero_documento));

CREATE INDEX IF NOT EXISTS ix_boletos_ativos_vencimento
    ON boletos (data_vencimento)
    WHERE excluido_em IS NULL;

CREATE INDEX IF NOT EXISTS ix_boletos_ativos_fase_cobranca
    ON boletos (status_cobranca, data_fase_cobranca)
    WHERE excluido_em IS NULL;

COMMIT;
