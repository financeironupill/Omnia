BEGIN;

UPDATE ocorrencias
SET status = 'Aguardando Recebimento/Pagamento'
WHERE status IN ('Aprovado', 'Aprovada');

INSERT INTO tipos_ocorrencia (codigo, descricao)
SELECT 'ERRO_EXP', 'Erro de Expedição'
WHERE NOT EXISTS (
    SELECT 1
    FROM tipos_ocorrencia
    WHERE LOWER(TRIM(descricao)) = LOWER('Erro de Expedição')
       OR UPPER(TRIM(codigo)) = 'ERRO_EXP'
);

COMMIT;
