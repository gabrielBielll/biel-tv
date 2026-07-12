// Aciona o agendador que agora vive DENTRO do Worker (fase 9).
// Mantido como atalho: `pnpm seed:local` (REBUILD=1 pra replanejar o futuro).
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'

try {
  const res = await fetch(`${BASE}/admin/schedule/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      rebuild: process.env.REBUILD === '1',
      ...(process.env.HOURS ? { hours: Number(process.env.HOURS) } : {}),
      ...(process.env.CANAL ? { canal: process.env.CANAL } : {}),
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  const reports = await res.json()
  for (const r of reports) {
    console.log(
      `${r.canal.padEnd(18)} ${r.skipped ? `— ${r.skipped}` : `+${r.added} blocos até ${new Date(r.until * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`}`,
    )
  }
} catch (e) {
  console.error(`falhou: ${e.message}\n(o Worker precisa estar no ar — rode \`pnpm dev\` antes)`)
  process.exit(1)
}
