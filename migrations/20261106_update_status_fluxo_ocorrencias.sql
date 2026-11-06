BEGIN;

UPDATE ocorrencias
SET status = CASE
    WHEN status IS NULL THEN 'Em Processo Interno'
    WHEN status = 'Em Aberto' THEN 'Em Processo Interno'
    WHEN status = 'Em Análise' THEN 'Em Processo Interno'
    WHEN status = 'Aprovada' THEN 'Aprovado'
    WHEN status = 'Aguardando Débito/Crédito' THEN 'Aguardando Recebimento/Pagamento'
    WHEN status = 'Resolvido' THEN 'Concluído'
    WHEN status = 'Finalizada' THEN 'Concluído'
    WHEN status = 'Reprovada' THEN 'Concluído'
    WHEN status = 'Cancelada' THEN 'Concluído'
END
WHERE status IN (
    'Em Aberto',
    'Em Análise',
    'Aprovada',
    'Aguardando Débito/Crédito',
    'Resolvido',
    'Finalizada',
    'Reprovada',
    'Cancelada'
) OR status IS NULL;

COMMIT;
