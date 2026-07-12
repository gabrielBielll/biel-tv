// Utilitário compartilhado pelos scripts de verificação que misturam d1()
// (spawnSync de um subprocesso wrangler, que bloqueia o event loop por
// ~1-2s) com fetch() pro wrangler dev. Nesse intervalo o servidor pode
// fechar a conexão keep-alive, e o próximo fetch nasce numa conexão morta
// ("fetch failed"/socket reset). Retry com backoff resolve.
export async function fetchRetry(url, opts, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, opts)
    } catch (e) {
      if (i >= tries) throw e
      await new Promise((r) => setTimeout(r, 500 * i))
    }
  }
}
