// Teste do reconciliador da fábrica de comerciais gerando VARIAÇÕES de locução:
// um comercial por frase gravada da série (pedido do Gabriel, 15/09/2026 —
// "só vejo 1 frase passando para cada comercial, quase dá pra decorar").
// Exercita o `reconciliaComerciaisGrade` REAL com um D1 mockado — sem servidor.
// Invariantes:
//   1) bloco sem comercial nenhum → nasce uma versão POR FRASE (até o teto);
//   2) cada versão nasce com `frase_id` DIFERENTE (senão a variação é fake);
//   3) frase que já tem versão viva não ganha outra (idempotente: rodar duas
//      vezes não duplica);
//   4) frota antiga (job sem frase_id) é identificada pelo transcript e a frase
//      dela não é refeita;
//   5) série com 1 frase só continua com 1 comercial (comportamento de antes);
//   6) teto de versões novas por rodada é respeitado (fila do Actions).
import { reconciliaComerciaisGrade } from '../apps/stream/src/fabrica-comerciais.ts'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

const CLIPES_BASE = (canal) => [
  { id: 'c_hora', canal, categoria: 'horario', chave: '16:00', series_id: null, rotulo: 'às quatro da tarde' },
  { id: 'c_freq', canal, categoria: 'frequencia', chave: 'todos', series_id: null, rotulo: 'todos os dias' },
  { id: 'c_ass', canal, categoria: 'conector', chave: 'encerramento', series_id: null, rotulo: 'na Jetix' },
]

// D1 mockado: responde por trecho de SQL e captura os INSERT de job.
function makeDB({ slots, jobs = [], promessas = [], prontos = [], clipes, samples, moldes }) {
  const inseridos = []
  const updates = []
  const prepare = (sql) => {
    let args = []
    const api = {
      bind: (...a) => { args = a; return api },
      all: async () => {
        if (/FROM channel_slots/.test(sql)) return { results: slots }
        if (/FROM commercial_build_jobs j JOIN moldes/.test(sql)) return { results: jobs }
        if (/FROM media_promises p\s+JOIN/.test(sql)) return { results: promessas }
        if (/FROM media_items m JOIN commercial_build_jobs/.test(sql)) return { results: prontos.map((id) => ({ id })) }
        if (/FROM voice_clips ORDER BY created_at/.test(sql)) return { results: clipes }
        if (/FROM program_samples/.test(sql)) return { results: samples.map((s) => ({ series_id: s })) }
        if (/FROM moldes ORDER BY/.test(sql)) return { results: moldes }
        return { results: [] }
      },
      first: async () => {
        if (/UNION SELECT media_id FROM commercial_build_jobs/.test(sql)) return null // nunca duplica id
        if (/FROM voice_clips WHERE categoria = 'nome'/.test(sql)) return { rotulo: 'Programa X' }
        return null
      },
      run: async () => {
        if (/INSERT INTO commercial_build_jobs/.test(sql)) {
          inseridos.push({ id: args[0], media_id: args[1], title: args[2], series_id: args[4], hora: args[6], frase_id: args[7] ?? null })
        } else if (/^UPDATE/.test(sql.trim())) updates.push(sql.trim().slice(0, 40))
        return { meta: { changes: 1 } }
      },
    }
    return api
  }
  return { env: { DB: { prepare, batch: async (st) => Promise.all(st.map((s) => s.run())) } }, inseridos, updates }
}

const SLOT = { canal: 'jetix', series_id: 'pucca', dias: '[1,2,3,4,5,6,7]', hora: '16:00' }
const MOLDES = [{ id: 'mo_1', canal: 'jetix' }]
const TRES_FRASES = [
  ...CLIPES_BASE('jetix'),
  { id: 'c_nome', canal: 'jetix', categoria: 'nome', chave: null, series_id: 'pucca', rotulo: 'Pucca' },
  { id: 'f1', canal: 'jetix', categoria: 'frase', chave: null, series_id: 'pucca', rotulo: 'A garotinha mais apaixonada da Coreia.' },
  { id: 'f2', canal: 'jetix', categoria: 'frase', chave: null, series_id: 'pucca', rotulo: 'Amor, ninjas e macarrão.' },
  { id: 'f3', canal: 'jetix', categoria: 'frase', chave: null, series_id: 'pucca', rotulo: 'Ela nunca desiste do Garu.' },
]

// ── 1+2. bloco vazio: uma versão por frase, cada uma com frase_id próprio ────
{
  const { env, inseridos } = makeDB({ slots: [SLOT], clipes: TRES_FRASES, samples: ['pucca'], moldes: MOLDES })
  const rep = await reconciliaComerciaisGrade(env)
  const frases = inseridos.map((i) => i.frase_id)
  check('3 frases → 3 versões do comercial', inseridos.length === 3, `${inseridos.length} jobs`)
  check('cada versão com uma frase DIFERENTE', new Set(frases).size === 3, frases.join(','))
  check('todas as frases gravadas viraram versão', ['f1', 'f2', 'f3'].every((f) => frases.includes(f)), frases.join(','))
  check('relatório diz qual locução nasceu', rep.gerados.every((g) => typeof g.frase === 'string'),
    rep.gerados.map((g) => g.frase).join(' | ').slice(0, 60))
  check('sem lacuna (kit completo)', rep.lacunas.length === 0)
}

// ── 3. idempotência: frase que já tem versão viva não ganha outra ────────────
{
  const jobs = [
    { id: 'cb_1', media_id: 'com_a', series_id: 'pucca', slot_dias: '[1,2,3,4,5,6,7]', slot_hora: '16:00', status: 'done', frase_id: 'f1', canal: 'jetix' },
  ]
  const { env, inseridos } = makeDB({
    slots: [SLOT], jobs, prontos: ['com_a'], clipes: TRES_FRASES, samples: ['pucca'], moldes: MOLDES,
    promessas: [{ media_id: 'com_a', status: 'confirmada', proposta: '{"tipo":"bloco_horario"}', condicao: '{"tipo":"bloco_horario"}', transcript: null }],
  })
  await reconciliaComerciaisGrade(env)
  const frases = inseridos.map((i) => i.frase_id)
  check('já existe versão da f1 → nascem só f2 e f3', inseridos.length === 2 && !frases.includes('f1'), frases.join(','))
}

// ── 4. frota antiga (sem frase_id): a frase é deduzida do transcript ─────────
{
  const jobs = [
    { id: 'cb_1', media_id: 'com_a', series_id: 'pucca', slot_dias: '[1,2,3,4,5,6,7]', slot_hora: '16:00', status: 'done', frase_id: null, canal: 'jetix' },
  ]
  const { env, inseridos } = makeDB({
    slots: [SLOT], jobs, prontos: ['com_a'], clipes: TRES_FRASES, samples: ['pucca'], moldes: MOLDES,
    promessas: [{
      media_id: 'com_a', status: 'confirmada', proposta: '{"tipo":"bloco_horario"}', condicao: '{"tipo":"bloco_horario"}',
      transcript: 'Amor, ninjas e macarrão. Pucca todos os dias às quatro da tarde na Jetix',
    }],
  })
  await reconciliaComerciaisGrade(env)
  const frases = inseridos.map((i) => i.frase_id)
  check('job antigo sem frase_id: transcript revela a f2 e ela não é refeita',
    inseridos.length === 2 && !frases.includes('f2'), frases.join(','))
}

// ── 5. série com UMA frase: continua com um comercial só ─────────────────────
{
  const umaFrase = TRES_FRASES.filter((c) => c.id !== 'f2' && c.id !== 'f3')
  const { env, inseridos } = makeDB({ slots: [SLOT], clipes: umaFrase, samples: ['pucca'], moldes: MOLDES })
  await reconciliaComerciaisGrade(env)
  check('1 frase gravada → 1 comercial (como era antes)', inseridos.length === 1, `${inseridos.length}`)
}

// ── 6. teto por rodada: não despeja a fábrica inteira na fila de uma vez ─────
{
  const series = Array.from({ length: 12 }, (_, i) => `serie_${i}`)
  const slots = series.map((s, i) => ({ canal: 'jetix', series_id: s, dias: '[1,2,3,4,5,6,7]', hora: `${String(8 + i).padStart(2, '0')}:00` }))
  const clipes = [
    ...series.flatMap((s) => [
      { id: `n_${s}`, canal: 'jetix', categoria: 'nome', chave: null, series_id: s, rotulo: s },
      { id: `${s}_f1`, canal: 'jetix', categoria: 'frase', chave: null, series_id: s, rotulo: 'frase um' },
      { id: `${s}_f2`, canal: 'jetix', categoria: 'frase', chave: null, series_id: s, rotulo: 'frase dois' },
      { id: `${s}_f3`, canal: 'jetix', categoria: 'frase', chave: null, series_id: s, rotulo: 'frase três' },
    ]),
    { id: 'c_freq', canal: 'jetix', categoria: 'frequencia', chave: 'todos', series_id: null, rotulo: 'todos os dias' },
    { id: 'c_ass', canal: 'jetix', categoria: 'conector', chave: 'encerramento', series_id: null, rotulo: 'na Jetix' },
    ...slots.map((s, i) => ({ id: `h_${i}`, canal: 'jetix', categoria: 'horario', chave: s.hora, series_id: null, rotulo: s.hora })),
  ]
  const { env, inseridos } = makeDB({ slots, clipes, samples: series, moldes: MOLDES })
  await reconciliaComerciaisGrade(env)
  check('36 versões possíveis → no máximo 15 por rodada', inseridos.length === 15, `${inseridos.length} jobs`)
  const primeiraSerie = inseridos.filter((i) => i.series_id === 'serie_0')
  check('o teto não deixa bloco pela metade sem motivo (cobre por ordem)', primeiraSerie.length === 3)
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
