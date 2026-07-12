# Feature: uploads persistentes e retomáveis

> Checkpoint de 2026-07-12. Estado: diagnóstico e desenho concluídos; implementação não iniciada.
> Prioridade: urgente, antes das demais entregas do Admin v2.

## Problema observado

Ao enviar vídeos ou uma pasta, a tela pode permanecer indefinidamente em
`enviando`. Se a página for recarregada, os itens desaparecem.

Em produção, durante o incidente, não havia nenhum `ingest_job` em `queued` ou
`processing` e a fábrica remota estava ativa. Isso confirma que os arquivos
travaram antes da fila, no upload do navegador para o staging.

## Causa

O fluxo atual tem uma janela sem estado durável:

1. Arquivo, lote e status existem apenas nas `ref`s do Vue.
2. O navegador envia o arquivo inteiro para `POST /admin/upload`.
3. O Worker lê o corpo inteiro com `arrayBuffer()` e só então grava no R2.
4. Somente depois disso o frontend cria o `ingest_job` no D1.

Enquanto a tela diz `enviando`, o servidor ainda não conhece o item. O XHR não
tem timeout, tratamento de abort nem retry. Um reload aborta a requisição e
apaga o único estado existente. Arquivos grandes também esbarram no limite de
request/memória do Worker.

O navegador não permite restaurar automaticamente um `<input type="file">`
depois de um reload. A sessão e as partes já recebidas podem persistir, mas o
usuário precisa selecionar novamente o mesmo arquivo ou pasta para autorizar a
continuação.

## Decisões

- Criar uma sessão no D1 **antes do primeiro byte**. Num lote, reservar todos
  os itens antes de começar a transmitir o primeiro arquivo.
- Enviar em multipart para o R2, com partes fixas (mínimo 5 MiB; sugestão inicial
  de 10–16 MiB), persistindo número, tamanho e ETag de cada parte confirmada.
- Após reload, listar sessões ativas no painel. Sem acesso ao arquivo local, a
  UI mostra `interrompido — selecione novamente para continuar`.
- Reconhecer o arquivo reanexado por caminho relativo, nome, tamanho e
  `lastModified`; reenviar somente partes ausentes.
- Ter timeout por parte, retry com backoff, progresso por arquivo e total,
  cancelar, tentar novamente e mensagens separando `enviando`, `na fila` e
  `processando`.
- Finalização idempotente: repetir `complete` nunca pode criar dois jobs.
- O endpoint monolítico atual fica apenas como compatibilidade temporária; o
  painel passa a usar o fluxo multipart.

## Modelo e API propostos

Nova migration com:

- `upload_sessions`: sessão, `media_id`, chave do staging, upload multipart do
  R2, fingerprint do arquivo, metadados editoriais, canais, tamanho das partes
  e timestamps.
- `upload_parts`: sessão, número da parte, ETag e tamanho confirmado.

Endpoints administrativos:

- `POST /admin/uploads` — valida e cria/retoma uma sessão.
- `GET /admin/uploads` — lista sessões incompletas e seu progresso.
- `PUT /admin/uploads/:session/parts/:part` — recebe uma parte em stream.
- `POST /admin/uploads/:session/complete` — completa o objeto e cria a fila.
- `DELETE /admin/uploads/:session` — aborta e limpa uma sessão incompleta.

A primeira versão pode encaminhar partes pequenas pelo Worker usando o binding
R2. A evolução posterior é URL pré-assinada para o navegador enviar cada parte
diretamente ao R2, com CORS restrito às origens do painel.

## Deleção definitiva

Ativar/desativar continua sendo a ação normal e segura. A deleção física fica
disponível como zona de perigo, com todas estas condições:

1. a mídia já precisa estar `disabled`;
2. não pode estar cobrindo o bloco que está no ar;
3. o operador marca que entende que a ação é irreversível;
4. digita exatamente `EXCLUIR <media_id>`;
5. o backend valida novamente todas as condições;
6. só então apaga o prefixo exato no R2 e referências de grade, canais, cues,
   eventos e fila, replanejando os canais afetados.

Falha parcial deve deixar a mídia desativada e permitir repetir a limpeza com
segurança. Prefixos parecidos nunca podem ser atingidos.

## Verificações necessárias

- Reload durante upload e retomada após reselecionar o arquivo/pasta.
- Lote registra todas as sessões antes de enviar bytes.
- Arquivo maior que 100 MB e arquivo dividido em múltiplas partes.
- Falha de rede, timeout, `429`/`5xx`, perda da resposta e retry idempotente.
- Dois arquivos com o mesmo nome em subpastas distintas.
- `complete` repetido produz exatamente um job.
- Cancelamento aborta o multipart e não deixa staging órfão.
- Deleção recusa mídia ativa, confirmação errada e mídia no ar.
- Deleção correta remove somente o prefixo e os registros esperados.

## Próxima execução

1. Criar a migration e os endpoints multipart.
2. Trocar o gerenciador de upload do admin e adicionar a tela de retomada.
3. Implementar a zona de perigo da deleção.
4. Criar verificação e2e específica para reload/retry/deleção.
5. Aplicar a migration, publicar Worker e Pages e fazer smoke test com um
   arquivo descartável antes de reenviar a pasta real.

