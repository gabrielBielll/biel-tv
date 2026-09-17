-- Índices pro AGENDADOR, medidos em 17/09/2026 (limpeza já resolvida pelos
-- 0026/0027, o topo do consumo passou a ser o rebuild da grade):
--
--   659.854 linhas /  38x  futuroDe: start_time_virtual > ? GROUP BY media_id
--   235.958 linhas /  40x  MAX(end_time_virtual) WHERE canal = ?
--   140.928 linhas /  24x  MAX(end_time_virtual) WHERE canal = ? AND end > ?
--
-- (canal, end_time_virtual): as duas consultas de MAX viram um seek no fim do
-- índice daquele canal — 1 linha em vez de ~5.900. É o "até onde a grade deste
-- canal já vai", que roda em toda montagem.
--
-- (start_time_virtual): o `futuroDe` passa a varrer só o FUTURO (~2.300 linhas)
-- em vez da tabela inteira (~20.000). Serve também ao commitAired, que filtra
-- pela mesma coluna.
--
-- Contexto: cada `scheduleChannel` custava ~30-60 mil linhas, e a fábrica
-- dispara um replanejamento por comercial montado — 15 builds consumiram 2,1
-- milhões de linhas (44% da cota diária) numa tacada só.
CREATE INDEX IF NOT EXISTS idx_epg_canal_fim ON epg_virtual (canal, end_time_virtual);
CREATE INDEX IF NOT EXISTS idx_epg_start ON epg_virtual (start_time_virtual);
