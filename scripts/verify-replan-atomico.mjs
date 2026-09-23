// Teste das duas defesas contra o estouro de cota de 23/09/2026, quando aplicar
// 352 âncoras pelo endpoint singular gastou o teto diário do D1 nas 9 primeiras
// chamadas e deixou o Disney com a grade meio apagada.
//
//   A) REBUILD É ATÔMICO — o DELETE do futuro viaja no mesmo `batch()` dos
//      INSERT. Se a escrita falha (cota, timeout, o que for), a grade ANTIGA
//      continua de pé. Antes o DELETE ia sozinho e a falha no meio deixava o
//      canal com o bloco no ar e mais nada: 404 no /live.
//   B) REPLAN É COALESCIDO — N pedidos seguidos no mesmo canal viram UM replan,
//      e pedido órfão (rajada interrompida) é terminado pelo cron.
import { scheduleChannel, pedeReplan, runScheduler } from '../apps/stream/src/scheduler.ts'

let pass = 0
let fail = 0
const check = (nome, ok, extra = '') => {
  if (ok) { pass++; console.log(`✅ ${nome}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${nome}${extra ? `  (${extra})` : ''}`) }
}

const ep = (id, series_id) => ({ id, tipo: 'episodio', duracao_seg: 1200, segment_count: 120, last_played_at: 0, series_id })
const CANAL = { break_target_seg: 120, comerciais_fieis: 1, episodios_por_bloco: 2 }
const CATALOGO = [ep('aaa_01', 'aaa'), ep('aaa_02', 'aaa'), ep('bbb_01', 'bbb')]

// D1 mockado que REGISTRA a ordem das escritas e sabe falhar sob demanda.
function makeDB({ media = CATALOGO, config = new Map(), falharNoBatch = false, canais = [{ id: 'ch' }] } = {}) {
  const log = []          // ['batch:DELETE+3INSERT', 'run:DELETE ...']
  const prepare = (sql) => {
    let bound = []
    const api = {
      bind: (...a) => { bound = a; return api },
      all: async () => {
        if (/FROM media_items m JOIN media_channels/.test(sql)) return { results: media }
        if (/FROM channels ORDER BY/.test(sql)) return { results: canais }
        if (/FROM config WHERE k LIKE/.test(sql)) {
          return { results: [...config].map(([k, v]) => ({ k, v })) }
        }
        return { results: [] }
      },
      first: async () => {
        if (/FROM channels WHERE id/.test(sql)) return CANAL
        if (/FROM config WHERE k = /.test(sql)) {
          const v = config.get(bound[0])
          return v == null ? null : { v }
        }
        if (/MAX\(end_time_virtual\) g/.test(sql)) return { g: null }
        if (/SELECT MAX\(end_time_virtual\)/.test(sql)) return { m: null }
        return null
      },
      run: async () => {
        log.push(`run:${sql.trim().split(/\s+/).slice(0, 3).join(' ')}`)
        if (/INSERT OR REPLACE INTO config/.test(sql)) config.set(bound[0], bound[1])
        if (/DELETE FROM config/.test(sql) && config.get(bound[0]) === bound[1]) config.delete(bound[0])
        return { meta: { changes: 1 } }
      },
      _sql: sql,
    }
    return api
  }
  const batch = async (stmts) => {
    const forma = stmts.map((s) => s._sql.trim().split(/\s+/)[0]).join('+')
    log.push(`batch:${forma}`)
    if (falharNoBatch) throw new Error('D1_ERROR: too many writes (cota)')
    return stmts.map(() => ({ meta: { changes: 1 } }))
  }
  return { env: { DB: { prepare, batch } }, log, config }
}

// ── A1. o DELETE do rebuild sai no MESMO batch dos INSERT ────────────────────
{
  const { env, log } = makeDB()
  await scheduleChannel(env, 'ch', 3, true)
  const batches = log.filter((l) => l.startsWith('batch:'))
  const deleteSolto = log.some((l) => l === 'run:DELETE FROM epg_virtual')
  check('rebuild: um batch só, começando pelo DELETE',
    batches.length === 1 && /^batch:DELETE\+INSERT/.test(batches[0]), batches[0])
  check('rebuild: nenhum DELETE de epg_virtual solto fora do batch', !deleteSolto)
}

// ── A2. batch que falha não deixa a grade apagada ───────────────────────────
{
  const { env, log } = makeDB({ falharNoBatch: true })
  let erro = null
  try { await scheduleChannel(env, 'ch', 3, true) } catch (e) { erro = e }
  check('rebuild: falha na escrita propaga o erro (não mente "ok")', erro !== null, String(erro).slice(0, 34))
  check('rebuild: falha não executou DELETE algum por fora',
    !log.some((l) => l.startsWith('run:DELETE FROM epg')))
}

// ── A3. rebuild que não produziu linha NÃO apaga a grade antiga ─────────────
// A invariante é "não gravou ⇒ não apagou", venha a desistência de onde vier:
// `sem conteúdo` (pool vazio, sai antes do corte), `t >= target` (horizonte já
// coberto) ou `rebuild sem linhas` (o laço não rendeu nada). Antes, as duas
// últimas já tinham apagado o futuro quando desistiam.
{
  const { env, log } = makeDB({ media: [] }) // catálogo vazio: nada a agendar
  const r = await scheduleChannel(env, 'ch', 3, true)
  check('rebuild sem conteúdo: desiste sem apagar', r.added === 0 && !!r.skipped, r.skipped)
  check('rebuild sem conteúdo: nenhuma escrita em epg_virtual',
    !log.some((l) => /epg_virtual|batch:DELETE/.test(l)), log.join(' ') || '(nada)')
}

// ── B1. rajada de pedidos vira UM replan ────────────────────────────────────
{
  const { env, config } = makeDB()
  let replans = 0
  const espiao = { DB: { ...env.DB, batch: async (s) => { replans++; return env.DB.batch(s) } } }
  // 20 pedidos disparados como a rajada real: ~6 por segundo, sobrepostos
  const rs = await Promise.all(Array.from({ length: 20 }, () => pedeReplan(espiao, 'ch')))
  check('debounce: 20 pedidos → 1 replan', replans === 1, `${replans} replan(s)`)
  check('debounce: 19 cederam, 1 replanejou',
    rs.filter((x) => x === 'replanejou').length === 1 && rs.filter((x) => x === 'cedeu').length === 19)
  check('debounce: marca limpa depois do replan', config.size === 0, `${config.size} marca(s)`)
}

// ── B2. pedido órfão (rajada interrompida) é terminado pelo cron ────────────
{
  const config = new Map([['replan_pedido:ch', '999-orfa']])
  const { env, log } = makeDB({ config })
  await runScheduler(env, { hours: 3 })
  check('cron: canal com marca pendente é REPLANEJADO (rebuild)',
    log.some((l) => /^batch:DELETE\+INSERT/.test(l)), log.filter((l) => l.startsWith('batch:')).join(' '))
  check('cron: a marca é consumida depois do replan', !config.has('replan_pedido:ch'))
}

// ── B3. sem marca pendente o cron segue incremental (não paga replan) ───────
{
  const { env, log } = makeDB()
  await runScheduler(env, { hours: 3 })
  check('cron sem marca: segue append-only, sem DELETE do futuro',
    !log.some((l) => /^batch:DELETE/.test(l)), log.filter((l) => l.startsWith('batch:')).join(' '))
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
