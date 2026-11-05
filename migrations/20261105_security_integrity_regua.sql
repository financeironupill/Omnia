BEGIN;

ALTER TABLE boletos
    ADD COLUMN IF NOT EXISTS data_fase_cobranca TIMESTAMPTZ;

UPDATE boletos
SET data_fase_cobranca = COALESCE(atualizado_em, criado_em, CURRENT_TIMESTAMP)
WHERE data_fase_cobranca IS NULL;

ALTER TABLE boletos
    ALTER COLUMN data_fase_cobranca SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN data_fase_cobranca SET NOT NULL;

CREATE TABLE IF NOT EXISTS boletos_regua_pendencias (
    id BIGSERIAL PRIMARY KEY,
    boleto_id INTEGER NOT NULL,
    etapa SMALLINT NOT NULL CHECK (etapa BETWEEN 1 AND 4),
    fase_origem TEXT NOT NULL,
    acao TEXT NOT NULL,
    data_fase_origem TIMESTAMPTZ NOT NULL,
    data_acao DATE NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Pendente', 'Concluida', 'Cancelada')),
    criado_por INTEGER NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    concluido_por INTEGER,
    concluido_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_boletos_regua_pendencia_ativa
    ON boletos_regua_pendencias (boleto_id, etapa, data_fase_origem)
    WHERE status = 'Pendente';

CREATE INDEX IF NOT EXISTS ix_boletos_regua_pendencias_fila
    ON boletos_regua_pendencias (data_acao, boleto_id)
    WHERE status = 'Pendente';

COMMIT;
