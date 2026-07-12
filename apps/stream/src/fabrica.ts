// Acorda a fábrica no GitHub Actions via repository_dispatch.
//
// Melhor esforço SEMPRE: se o GitHub estiver fora, o token morrer ou os vars
// não existirem, nada aqui pode derrubar um upload — o cron diário re-dispara
// enquanto houver fila, e o workflow também aceita disparo manual
// (workflow_dispatch) como último recurso.

type Env = {
  DB: D1Database
  GH_DISPATCH_TOKEN?: string
  GH_REPO?: string
}

export async function dispatchFabrica(env: Env): Promise<void> {
  if (!env.GH_DISPATCH_TOKEN || !env.GH_REPO) return
  try {
    await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'biel-tv-worker',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ event_type: 'fabrica' }),
    })
  } catch {
    /* melhor esforço — o cron diário cobre */
  }
}

// Chamado pelo cron diário: se sobrou fila (dispatch perdido, run que morreu
// no timeout), acorda a fábrica de novo.
export async function dispatchSeTemFila(env: Env): Promise<void> {
  const row = await env.DB.prepare("SELECT COUNT(*) c FROM ingest_jobs WHERE status = 'queued'")
    .first<{ c: number }>()
  if ((row?.c ?? 0) > 0) await dispatchFabrica(env)
}
