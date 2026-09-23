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
import { scheduleChannel, pedeReplan, proximaOcorrencia, runScheduler } from '../apps/stream/src/scheduler.ts'

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
  const log = []          // ['batch:DELETE+INSERT', 'run:DELETE ...']
  const cortes = []       // o `cut` de cada DELETE de epg_virtual
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
        // upsert que guarda o MENOR — o mesmo min() do SQL, em JS
        else if (/INSERT INTO config/.test(sql) && /min\(/.test(sql)) {
          const antes = config.has(bound[0]) ? Number(config.get(bound[0])) : Infinity
          config.set(bound[0], String(Math.min(antes, Number(bound[1]))))
        }
        if (/DELETE FROM config/.test(sql)) {
          if (bound.length < 2 || config.get(bound[0]) === bound[1]) config.delete(bound[0])
        }
        return { meta: { changes: 1 } }
      },
      _sql: sql,
      get _bound() { return bound },
    }
    return api
  }
  const batch = async (stmts) => {
    const rotulo = (st) => {
      const verbo = st._sql.trim().split(/\s+/)[0]
      if (verbo !== 'DELETE' || !/epg_virtual/.test(st._sql)) return verbo
      // o rebuild apaga o FUTURO (por start); a retenção apaga o PASSADO (por end)
      return /start_time_virtual >=/.test(st._sql) ? 'DELETEfuturo' : 'DELETEretencao'
    }
    const forma = stmts.map(rotulo).join('+')
    // guarda só o corte do rebuild — a retenção tem outro bind e outro sentido
    for (const st of stmts) {
      if (rotulo(st) === 'DELETEfuturo') cortes.push(st._bound[1])
    }
    if (/epg_virtual/.test(stmts[0]?._sql ?? '')) {
      log.push(`batch:${forma}`)
      if (falharNoBatch) throw new Error('D1_ERROR: too many writes (cota)')
      return stmts.map(() => ({ meta: { changes: 1 } }))
    }
    return Promise.all(stmts.map((st) => st.run()))
  }
  return { env: { DB: { prepare, batch } }, log, config, cortes }
}

// ── A1. o DELETE do rebuild sai no MESMO batch dos INSERT ────────────────────
{
  const { env, log } = makeDB()
  await scheduleChannel(env, 'ch', 3, true)
  const batches = log.filter((l) => l.startsWith('batch:'))
  const deleteSolto = log.some((l) => l === 'run:DELETE FROM epg_virtual')
  check('rebuild: um batch só, começando pelo DELETE',
    batches.length === 1 && /^batch:DELETEfuturo\+INSERT/.test(batches[0]), batches[0])
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
  // conta só batch de GRADE — `pedeReplan` usa batch pras marcas em `config` também
  const espiao = { DB: { ...env.DB, batch: async (st) => {
    if (/epg_virtual/.test(st[0]?._sql ?? '')) replans++
    return env.DB.batch(st)
  } } }
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
    log.some((l) => /^batch:DELETEfuturo\+INSERT/.test(l)), log.filter((l) => l.startsWith('batch:')).join(' '))
  check('cron: a marca é consumida depois do replan', !config.has('replan_pedido:ch'))
}

// ── B3. sem marca pendente o cron segue incremental (não paga replan) ───────
{
  const { env, log } = makeDB()
  await runScheduler(env, { hours: 3 })
  check('cron sem marca: segue append-only, sem DELETE do futuro',
    !log.some((l) => /DELETEfuturo/.test(l)), log.filter((l) => l.startsWith('batch:')).join(' '))
  check('cron: a limpeza da retenção roda FATIADA por canal (idx_epg_canal_fim)',
    log.some((l) => /^batch:DELETEretencao/.test(l)), log.filter((l) => l.startsWith('batch:')).join(' '))
}

// ── C. REBUILD PARCIAL: só reescreve de `desde` em diante ───────────────────
// A economia é secundária; o que importa é a grade que o app JÁ MOSTROU no guia
// parar de se embaralhar cada vez que se mexe numa faixa da noite.
{
  const agora = Math.floor(Date.now() / 1000)

  // C1. próxima ocorrência: cai no futuro, na hora certa, num dia pedido
  const amanha = proximaOcorrencia([1, 2, 3, 4, 5, 6, 7], '21:30')
  const hhmm = new Date((amanha - 3 * 3600) * 1000).toISOString().slice(11, 16)
  check('proximaOcorrencia: no futuro e na hora pedida', amanha > agora && hhmm === '21:30',
    `${hhmm}, +${((amanha - agora) / 3600).toFixed(1)}h`)
  const soDomingo = proximaOcorrencia([7], '10:00')
  const iso = new Date((soDomingo - 3 * 3600) * 1000).getUTCDay()
  check('proximaOcorrencia: respeita os dias da semana', iso === 0, `dia ISO ${iso === 0 ? 7 : iso}`)
  check('proximaOcorrencia: hora inválida → 0 (rebuild total, lado seguro)',
    proximaOcorrencia([1], '99:99') === 0)

  // C2. o corte do DELETE é o `desde`, não "tudo depois do que está no ar"
  {
    const { env, cortes } = makeDB()
    await scheduleChannel(env, 'ch', 48, true, amanha)
    check('rebuild parcial: DELETE corta em `desde`', cortes.at(-1) === amanha,
      `cut=+${((cortes.at(-1) - agora) / 3600).toFixed(1)}h`)
  }

  // C3. `desde` no passado não pode invadir o que está no ar
  {
    const { env, cortes } = makeDB()
    await scheduleChannel(env, 'ch', 48, true, agora - 10 * 86400)
    check('rebuild parcial: `desde` no passado vira rebuild total (não corta o no ar)',
      cortes.at(-1) >= agora - 20, `cut=${((cortes.at(-1) - agora) / 60).toFixed(1)}min`)
  }

  // C4. rajada com `desde` diferentes → vence o MENOR
  // (mexeu nas 07:00 e nas 21:30: replanejar só das 21:30 deixaria a das 07:00
  //  valendo no papel e não na grade)
  {
    const { env, cortes } = makeDB()
    const cedo = agora + 3600
    const tarde = agora + 20 * 3600
    const rs = await Promise.all([
      pedeReplan(env, 'ch', undefined, tarde),
      pedeReplan(env, 'ch', undefined, cedo),
      pedeReplan(env, 'ch', undefined, tarde),
    ])
    check('debounce: `desde` da rajada é o MENOR', cortes.at(-1) === cedo,
      `cut=+${((cortes.at(-1) - agora) / 3600).toFixed(1)}h (menor era +1.0h)`)
    check('debounce: ainda assim um replan só', cortes.length === 1 && rs.filter((x) => x === 'replanejou').length === 1)
  }

  // C5. pedido sem `desde` força rebuild total mesmo numa rajada com `desde`
  {
    const { env, cortes } = makeDB()
    await Promise.all([
      pedeReplan(env, 'ch', undefined, agora + 20 * 3600),
      pedeReplan(env, 'ch'), // sem desde = "vale já"
    ])
    check('debounce: pedido sem `desde` puxa a rajada pra rebuild total',
      cortes.at(-1) < agora + 60, `cut=+${((cortes.at(-1) - agora) / 60).toFixed(1)}min`)
  }
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
