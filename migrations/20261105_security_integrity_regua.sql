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

ALTER TABLE boletos_regua_pendencias
    ADD COLUMN IF NOT EXISTS fase_origem TEXT,
    ADD COLUMN IF NOT EXISTS data_fase_origem TIMESTAMPTZ;

UPDATE boletos_regua_pendencias AS pendencia
SET fase_origem = COALESCE(
        pendencia.fase_origem,
        boleto.status_cobranca,
        CASE pendencia.etapa
            WHEN 1 THEN 'Aguardando Régua'
            WHEN 2 THEN 'Aviso 1 (Notificação)'
            WHEN 3 THEN 'Aviso 2 (Alerta Cartório)'
            WHEN 4 THEN 'Aviso 3 (Aviso Final)'
        END
    ),
    data_fase_origem = COALESCE(
        pendencia.data_fase_origem,
        boleto.data_fase_cobranca,
        CURRENT_TIMESTAMP
    )
FROM boletos AS boleto
WHERE boleto.id = pendencia.boleto_id
  AND (pendencia.fase_origem IS NULL OR pendencia.data_fase_origem IS NULL);

UPDATE boletos_regua_pendencias
SET fase_origem = CASE etapa
        WHEN 1 THEN 'Aguardando Régua'
        WHEN 2 THEN 'Aviso 1 (Notificação)'
        WHEN 3 THEN 'Aviso 2 (Alerta Cartório)'
        WHEN 4 THEN 'Aviso 3 (Aviso Final)'
    END,
    data_fase_origem = COALESCE(data_fase_origem, CURRENT_TIMESTAMP)
WHERE fase_origem IS NULL OR data_fase_origem IS NULL;

ALTER TABLE boletos_regua_pendencias
    ALTER COLUMN fase_origem SET NOT NULL,
    ALTER COLUMN data_fase_origem SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_boletos_regua_pendencia_ativa
    ON boletos_regua_pendencias (boleto_id, etapa, data_fase_origem)
    WHERE status = 'Pendente';

CREATE INDEX IF NOT EXISTS ix_boletos_regua_pendencias_fila
    ON boletos_regua_pendencias (data_acao, boleto_id)
    WHERE status = 'Pendente';

COMMIT;
