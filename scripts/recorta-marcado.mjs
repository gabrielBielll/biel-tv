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
// ── o PLANO vem do D1: é o que o Gabriel marcou e SALVOU no editor ────────
// Regra dele (2026-07-15): "quando eu clicar em salvar, aí sim está aprovado
// pra ir pro ar". Salvar = aprovação ⇒ estas peças nascem 'ready'.
// (o corte AUTOMÁTICO é o contrário: nasce 'disabled' e espera ele no editor —
//  ver scripts/recorta-acervo.mjs. Palpite da máquina não vai ao ar sozinho.)
function carregaPlano() {
  const rows = d1(`SELECT cm.compilado_id, cm.pecas, mc.channel_id AS canal
     FROM cortes_marcados cm
     LEFT JOIN media_channels mc ON mc.media_id = cm.compilado_id
     WHERE cm.status = 'marcado'`)
  return rows.map((r) => ({
    src: r.compilado_id, canal: r.canal ?? 'jetix', exato: true,
    pecas: JSON.parse(r.pecas),
  }))
}

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

const PLANO = carregaPlano()
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
      // ⚠️ SEM NOME ⇒ HERDA O TÍTULO DA FONTE, nunca "trecho 0m01".
      // Saiu `com_disney_channel_disney_channel_trecho_0m01` pra uma peça que é
      // "OS PADRINHOS MÁGICOS, NO DISNEY CHANNEL" — a fonte tinha o nome certo o
      // tempo todo e eu inventei um rótulo que não diz nada. O Gabriel marca por
      // cima de peça JÁ NOMEADA (é o fluxo de polir): o título dela é a melhor
      // informação disponível, não o timestamp de onde ele começou a marcar.
      // Só cai no genérico quando a fonte também não tem título.
      const herdado = String(row.titulo ?? '').trim()
      const nome = pc.nome ?? (herdado && herdado !== row.id ? herdado : `${p.canal} · trecho ${fmtT(pc.ini)}`)

      // ⚠️ id a partir do NOME LIMPO, sem empilhar sufixo.
      // Saiu `com_cartoon_network_curtas_cn_jo_cortado_cortado` e
      // `com_jetix_pucca_2_cortado`: cada rodada grudava mais um `_cortado`/`_N`
      // no id ANTERIOR. Como ele repoli a mesma peça várias vezes (é o fluxo),
      // o id crescia a cada volta. Partir do nome mantém estável: a Pucca
      // repolida 5× continua `com_jetix_pucca`, e a aposentadoria tira a velha.
      const base = `com_${slug(p.canal)}_${slug(nome)}`
      // ⚠️ APOSENTAR a geração anterior desta MESMA peça, em vez de empilhar.
      // Regra do Gabriel (2026-07-15): "ele deve desativar o vídeo antigo pra não
      // ficar vários iguais na programação".
      //
      // O `resolveId` sozinho evita SOBRESCREVER (INSERT OR REPLACE apaga em
      // silêncio) — mas ao dar _2, _3, _4 ele criava GERAÇÕES. Cada vez que eu
      // re-rodei o script (ex.: depois da falha do Força do Tempo) tudo era
      // refeito e empilhava mais uma: chegou a 4 Força Animal, 2 Medabots, 2
      // Pucca, 2 Shaman King e 2 Batalhão TOCANDO JUNTOS no canal.
      // Evitar o id repetido não basta: é preciso tirar o velho do ar.
      const velhas = d1(`SELECT id FROM media_items
        WHERE tipo='comercial' AND status='ready'
          AND json_extract(metadata,'$.title') = '${String(nome).replace(/'/g, "''")}'`)
      const id = resolveId(base.slice(0, 60), ids)
      ids.add(id)
      if (DRY) { log(`  · [dry] ${id}  ${pc.ini}→${pc.fim} (${dur}s)  "${nome}"`); feito.push(id); desta++; continue }
      const out = join(WORK, `p${i}.mp4`)
      await extraiTrecho(m, pc.ini, pc.fim, out)
      const r = spawnSync(process.execPath, ['--dns-result-order=ipv4first',
        join(ROOT, 'packages/pipeline/src/cli.mjs'), 'ingest', out,
        '--id', id, '--tipo', 'comercial', '--title', nome,
        '--canais', p.canal, '--target', 'remote', '--base-url', '',
        // 'ready': ele marcou e SALVOU — o salvar É a aprovação (regra dele).
        // O cortador AUTOMÁTICO usa 'disabled'; aqui quem cortou foi ele.
        '--status', 'ready'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
      rmSync(out, { force: true })
      if (r.status !== 0) { log(`  ✖ ${id}: ${String(r.stderr || r.stdout).trim().split('\n').at(-1)?.slice(0, 110)}`); continue }
      // só agora que a nova está no ar: aposenta as anteriores do mesmo nome
      for (const v of velhas) {
        if (v.id === id) continue
        d1(`UPDATE media_items SET status='disabled' WHERE id='${v.id}'`)
        log(`     ↳ aposentou a anterior: ${v.id}`)
      }
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
    // A fonte sai do ar só depois das peças DELA entrarem — e aqui elas já
    // entram 'ready', então a substituição é imediata e o canal nunca fica sem.
    // `desta`, não `feito.length`: o acumulador global fez 3 comerciais sumirem
    // do rodízio sem substituto (ver o commit b461477).
    if (!DRY && desta > 0) {
      d1(`UPDATE media_items SET status='disabled' WHERE id='${row.id}'`)
      d1(`UPDATE cortes_marcados SET status='pronto', n_pecas=${desta}, updated_at=unixepoch()
          WHERE compilado_id='${row.id}'`)
      log(`  ⏻ fonte fora do ar · ${desta} peça(s) no ar`)
    } else if (!DRY) {
      d1(`UPDATE cortes_marcados SET status='error', error='nenhuma peça saiu', updated_at=unixepoch()
          WHERE compilado_id='${row.id}'`)
      log(`  ⚠ nenhuma peça entrou — fonte intacta`)
    }
  } catch (e) { log(`✖ ${p.src}: ${String(e.message ?? e).slice(0, 160)}`) }
}
log(`\n⇒ ${feito.length} peças${DRY ? ' (DRY — nada escrito)' : ' no catálogo'}`)
