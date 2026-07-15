// Recorta pelas fronteiras que o GABRIEL anotou assistindo — não por detecção.
//
// POR QUE ASSIM: 6 sinais automáticos foram medidos contra o gabarito dele no
// compilado de 390s e nenhum serve —
//     cena           → 5/6, mas dispara 138× em 390s (96% falso)
//     silêncio       → 3/6 · buraco de fala → 1/6 · preto → 0/6
// O placar do motor automático contra o acervo: 24 peças cortadas, 23 reprovadas
// por ele. Comercial de 2004 emenda direto — não há marca pra máquina achar.
// Ele, assistindo, acertou tudo em minutos, e TODAS as fronteiras dele caem
// redondas na grade (29s, 29.5s, 30s, 60s, 10s) — o que confirma a leitura.
//
// Aqui a máquina faz só o que sabe: cortar com precisão de frame (-ss depois do
// -i, erro ≤ 1 frame medido), normalizar, segmentar, subir e registrar.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG, concatParts, extraiTrecho, probe } from '../packages/pipeline/src/ffmpeg.mjs'
import { resolveId } from '../packages/pipeline/src/cortador.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry-run')
const WORK = join(ROOT, '.ingest-work', '_recorte')
mkdirSync(WORK, { recursive: true })
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`)

// ── o plano, transcrito dos comentários dele (2026-07-15) ─────────────────
// mm:ss → segundos. Os nomes são os DELE: quem assistiu sabe o que é, e
// "Iue Falante"/"Margo" provaram que o whisper inventa nome próprio.
const PLANO = [
  {
    src: 'com_jetix_intervalo_comercial_hi', canal: 'jetix',
    // "aos 5min e alguns milésimos quase chegando em 51 segundos começa o
    //  tempestade ninja e termina aos 5:30 quase 5:31" → confirmado: 5:00.9→5:30.9
    // "aos 5:43 e meio quase 5:44 e termina as 6:13"
    // "aos 6:18 começo o batalhão e termina em 7:53 e já começa o medabots em
    //  seguida e vai até 8:22. aos 8:35 começa o do [Shaman] king e termina 9:04"
    pecas: [
      { ini: 300.9, fim: 330.9, nome: 'Power Rangers: Tempestade Ninja' },
      { ini: 343.5, fim: 373.0, nome: null }, // ele não nomeou — o LLM nomeia
      { ini: 378.0, fim: 473.0, nome: 'Batalhão' },
      { ini: 473.0, fim: 502.0, nome: 'Medabots' },
      { ini: 515.0, fim: 544.0, nome: 'Shaman King' },
    ],
  },
  {
    src: 'ep_jetix_brasil_intervalo_muscu', canal: 'jetix',
    // "as 0:23 e termina em 0:52 quase 0:53. logo depois começa o da pucca e
    //  termina em 1:55. aos 2:30 começa o power rangers força animal e vai até
    //  2:59. em seguida um comercial bacana da jetix MUDO pode ser usado em
    //  qualquer lugar, termina em 3:09. o resto é lixo só recortes"
    // 1:55→2:30 e depois de 3:09: descartado (confirmado por ele)
    pecas: [
      { ini: 23.0, fim: 52.5, nome: null },
      { ini: 52.5, fim: 115.0, nome: 'Pucca' },
      { ini: 150.0, fim: 179.0, nome: 'Power Rangers: Força Animal' },
      { ini: 179.0, fim: 189.0, nome: 'Jetix — vinheta muda' },
    ],
  },
  // ── as avulsas: comerciais que já existiam e ele mandou aparar ───────────
  {
    src: 'com_power_rangers_ranger_vermelh', canal: 'jetix',
    // "começa bem mas deveria cortar em 24 segundos e alguns milissegundos pq
    //  depois entra comercial do cinescopio"
    pecas: [{ ini: 0, fim: 24.0, nome: 'Power Rangers — Ranger Vermelho' }],
  },
  {
    src: 'com_perfil_power_rangers_spd_sky', canal: 'jetix',
    // "aos 22 segundos começa o do força animal e termina aos 34 com tela preta,
    //  e antes tem o anúncio do spd — dava pra cortar e fazer DOIS comerciais"
    pecas: [
      { ini: 0, fim: 22.0, nome: 'Power Rangers SPD — Sky Tate' },
      { ini: 22.0, fim: 34.0, nome: 'Power Rangers: Força Animal' },
    ],
  },
  {
    src: 'com_comercial_de_power_rangers_f', canal: 'jetix',
    // "o comercial real do spd começa aos 1 segundo e pode cortar aos 57 pq
    //  depois vem o da beyblade e termina em 1:05 pq depois vem tela preta —
    //  dá pra fazer 2 comerciais desse"
    pecas: [
      { ini: 1.0, fim: 57.0, nome: 'Power Rangers SPD' },
      { ini: 57.0, fim: 65.0, nome: 'Beyblade' },
    ],
  },
  // ⚠️ ids EXATOS: existem QUATRO "Curtas CN" e o prefixo 'com_cartoon_network_cu'
  // casava com o Johnny Bravo e o Freddy — o dry-run flagrou que eu ia cortar o
  // vídeo errado e deixar os marcados intactos.
  {
    src: 'cartoon_network_curtas_cn_pr', canal: 'cartoon_network', exato: true,
    // "fica com a tela preta a partir de 1 min e 1 segundos, pode cortar o resto"
    pecas: [{ ini: 0, fim: 61.0, nome: null }],
  },
  {
    src: 'ep_cartoon_network_curtas_cn_sh', canal: 'cartoon_network', exato: true,
    // "é a mesma coisa, pode cortar com 1min e 1seg"
    pecas: [{ ini: 0, fim: 61.0, nome: null }],
  },
  {
    src: 'com_cartoon_network_curtas_cn_jo', canal: 'cartoon_network', exato: true,
    // marcado preto_demais também — mesmo defeito dos irmãos
    pecas: [{ ini: 0, fim: 61.0, nome: null }],
  },
]

function d1(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'biel-tv-db', '--remote', '--json', '--command', sql],
    { cwd: join(ROOT, 'apps/stream'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`d1 falhou: ${String(r.stderr).slice(0, 200)}`)
  const m = String(r.stdout).match(/\[[\s\S]*\]/)
  if (!m) throw new Error('d1 sem JSON')
  return JSON.parse(m[0])[0].results
}
const fmtT = (t) => `${Math.floor(t/60)}m${String(Math.round(t%60)).padStart(2,'0')}`
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 42)

/** Remonta o master dos .ts do R2 (cache: se já está em disco, reusa). */
async function master(id, segCount) {
  const dir = join(WORK, id)
  mkdirSync(dir, { recursive: true })
  const out = join(dir, 'master.mp4')
  if (existsSync(out)) return out
  log(`  baixando ${segCount} segmentos…`)
  const arqs = []
  for (let i = 0; i < segCount; i++) {
    const n = String(i).padStart(5, '0')
    const seg = join(dir, `seg${n}.ts`)
    if (!existsSync(seg)) {
      const r = spawnSync('npx', ['wrangler', 'r2', 'object', 'get',
        `biel-tv-media/media/${id}/seg${n}.ts`, '--file', seg, '--remote'],
        { cwd: join(ROOT, 'apps/stream'), stdio: 'ignore' })
      if (r.status !== 0) throw new Error(`falhou baixar seg${n}`)
    }
    arqs.push(seg)
  }
  // Usa o concatParts do projeto (valida a soma das durações e cai pro filtro
  // quando o `-c copy` não é seguro) em vez de montar `-f concat -c copy` na mão.
  //
  // ⚠️ RESSALVA — eu culpei o concat cru pelo erro do com_comercial_de_power_rangers_f
  // e ESTAVA ERRADO: o concatParts falha exatamente igual ali. A causa real é
  // corrupção no MATERIAL: o seg00004.ts tem amostras de áudio inválidas
  // ("[aac] Input contains (near) NaN/+-Inf") e o encoder recusa — com razão.
  // Veio assim do YouTube e atravessou o pipeline porque ninguém tinha
  // re-encodado o áudio dele até agora. Isolado testando segmento por segmento:
  // 6 dos 7 passam sozinhos, só o 4 quebra.
  const jr = await concatParts(arqs, out, { forcarFiltro: true })
  log(`  master remontado (${jr.metodo}, ${jr.partes} partes)`)
  for (let i = 0; i < segCount; i++) rmSync(join(dir, `seg${String(i).padStart(5, '0')}.ts`), { force: true })
  return out
}

const ids = new Set(d1('SELECT id FROM media_items').map((r) => r.id))
log(`${ids.size} ids no catálogo · ${PLANO.length} fontes · ${PLANO.reduce((a, p) => a + p.pecas.length, 0)} peças planejadas`)

const feito = []
for (const p of PLANO) {
  try {
    const row = d1(`SELECT id, duracao_seg, segment_count,
        COALESCE(json_extract(metadata,'$.title'), id) AS titulo
      FROM media_items WHERE id ${p.exato ? `= '${p.src}'` : `LIKE '${p.src}%'`} LIMIT 1`)[0]
    if (!row) { log(`✖ ${p.src}: não achei no catálogo`); continue }
    log(`\n━━━ ${row.id} (${Math.round(row.duracao_seg)}s) ━━━`)
    let desta = 0 // peças DESTA fonte (o `feito` é global — ver a trava abaixo)
    const m = await master(row.id, row.segment_count)
    const { duration } = await probe(m)

    for (const [i, pc] of p.pecas.entries()) {
      if (pc.fim > duration + 0.5) { log(`  ⚠ peça ${i} vai até ${pc.fim}s mas o arquivo tem ${duration.toFixed(1)}s — pulei`); continue }
      const dur = Math.round((pc.fim - pc.ini) * 100) / 100
      // aparo (peça única cobrindo quase o arquivo todo) = MESMO comercial sem o
      // preto do fim ⇒ mantém o nome original. Só peça de compilado sem nome dele
      // ganha rótulo genérico, e mesmo assim legível.
      const aparo = p.pecas.length === 1 && pc.ini < 2 && pc.fim > duration * 0.6
      const nome = pc.nome ?? (aparo ? String(row.titulo ?? row.id) : `${p.canal} · trecho ${fmtT(pc.ini)}`)
      // aparo gera id igual ao do original (mesmo nome) → resolveId daria _2, que
      // não diz nada. '_cortado' explica por que existem dois.
      const base = aparo ? `${row.id}_cortado` : `com_${slug(p.canal)}_${slug(nome)}`
      const id = resolveId(base.slice(0, 60), ids)
      ids.add(id)
      if (DRY) { log(`  · [dry] ${id}  ${pc.ini}→${pc.fim} (${dur}s)  "${nome}"`); feito.push(id); desta++; continue }
      const out = join(WORK, `p${i}.mp4`)
      await extraiTrecho(m, pc.ini, pc.fim, out)
      const r = spawnSync(process.execPath, ['--dns-result-order=ipv4first',
        join(ROOT, 'packages/pipeline/src/cli.mjs'), 'ingest', out,
        '--id', id, '--tipo', 'comercial', '--title', nome,
        '--canais', p.canal, '--target', 'remote', '--base-url', ''],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
      rmSync(out, { force: true })
      if (r.status !== 0) { log(`  ✖ ${id}: ${String(r.stderr || r.stdout).trim().split('\n').at(-1)?.slice(0, 110)}`); continue }
      log(`  ✔ ${id} (${dur}s) — ${nome}`)
      feito.push(id); desta++
    }
    // a fonte sai do ar SÓ depois das peças entrarem (nunca deletada: os .ts
    // ficam no R2, dá pra reprocessar sem baixar nada)
    // ⚠️ CONTAR AS PEÇAS DESTA FONTE, não o acumulador global.
    // Era `if (feito.length)` — e `feito` acumula TODAS as fontes, então depois da
    // 1ª peça de qualquer uma ele nunca mais é zero e TODA fonte saía do ar,
    // tivesse entregue peça ou não. Foi assim que 3 comerciais sumiram do
    // rodízio sem substituto (o Força do Tempo, o Groovies e o Sábado Mágico) —
    // e eu tinha DESCRITO essa trava pro Gabriel como se ela funcionasse.
    // A trava só parecia funcionar antes porque cada fonte entregava peça antes
    // de chegar aqui: o bug estava dormindo até a 1ª falha real.
    if (!DRY && desta > 0) {
      d1(`UPDATE media_items SET status='disabled' WHERE id='${row.id}'`)
      log(`  ⏻ fonte desativada (${desta} peça(s) no ar)`)
    } else if (!DRY) {
      log(`  ⚠ nenhuma peça desta fonte entrou — CONTINUA no ar de propósito`)
    }
  } catch (e) { log(`✖ ${p.src}: ${String(e.message ?? e).slice(0, 160)}`) }
}
log(`\n⇒ ${feito.length} peças${DRY ? ' (DRY — nada escrito)' : ' no catálogo'}`)
