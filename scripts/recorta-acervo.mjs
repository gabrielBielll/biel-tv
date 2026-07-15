// Recorta os compilados de "Intervalo" que JÁ ESTÃO no catálogo em peças soltas.
// Spec: docs/features/cortador-comerciais.md (motor v3)
//
// Uso:
//   node scripts/recorta-acervo.mjs --dry-run   → só analisa e lista o que faria
//   node scripts/recorta-acervo.mjs             → recorta, ingere e desativa os originais
//
// POR QUE ISTO EXISTE (e não é o tickComercial da fábrica): os compilados já
// estão no acervo, então não há link pra colar nem download pra fazer — é uma
// leva única sobre material que já passou pelo pipeline. O tickComercial serve
// pro fluxo futuro (colar link → automático); este script serve pra HOJE.
//
// SEGURANÇA (isto mexe em PRODUÇÃO, e roda sozinho):
//  · cache por etapa: cair no meio não refaz o whisper (3min por compilado)
//  · o original só é DESATIVADO depois que as peças dele entraram — se o
//    recorte falhar, o intervalo continua no ar (ruim, mas melhor que um canal
//    com buraco)
//  · resolveId contra os ids REAIS do catálogo: o pipeline registra com
//    INSERT OR REPLACE e id repetido sobrescreve em silêncio
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG, extraiTrecho, detectSilence, detectBlack, detectScene, probe } from '../packages/pipeline/src/ffmpeg.mjs'
import { achaBuracos, ancoraCorte, fundePelaGrade, classificaPeca, resolveId } from '../packages/pipeline/src/cortador.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry-run')
const WORK = join(ROOT, '.ingest-work', '_recorte')
mkdirSync(WORK, { recursive: true })

const ts = () => new Date().toISOString().slice(11, 19)
const log = (s) => console.log(`[${ts()}] ${s}`)

// ── acervo do Gabriel (2026-07-15) ────────────────────────────────────────
const PROGRAMAS = [
  'Os Padrinhos Mágicos', 'Yin Yang Yo!', 'Power Rangers: Galáxia Perdida',
  'Power Rangers: O Resgate', 'Pucca', 'Beyblade',
  'Madagascar: Perseguidos por um Cupcake Gigante',
  'Super Esquadrão dos Macacos Robôs Hiperforça Já!',
  'O Show dos Looney Tunes', 'A Vida e Aventuras de Juniper Lee',
  'Martin Mystery', 'Hey Arnold!', 'Danny Phantom', 'Jake Long: O Dragão Ocidental',
]

const DEEPSEEK_KEY = (() => {
  const f = join(ROOT, 'apps/stream/.dev.vars')
  if (!existsSync(f)) throw new Error('.dev.vars não encontrado — sem chave do DeepSeek')
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    const i = l.indexOf('=')
    if (i > 0 && l.slice(0, i).trim() === 'DEEPSEEK_API_KEY') return l.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  throw new Error('DEEPSEEK_API_KEY ausente no .dev.vars')
})()

// ── D1 ────────────────────────────────────────────────────────────────────
function d1(sql, remote = true) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'biel-tv-db', remote ? '--remote' : '--local', '--json', '--command', sql],
    { cwd: join(ROOT, 'apps/stream'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`d1 falhou: ${String(r.stderr).slice(0, 300)}`)
  const m = String(r.stdout).match(/\[[\s\S]*\]/)
  if (!m) throw new Error(`d1 sem JSON: ${String(r.stdout).slice(0, 200)}`)
  return JSON.parse(m[0])[0].results
}

// ── LLM (o julgamento é texto: DeepSeek, que tem cota) ─────────────────────
async function ds(system, user, tent = 3) {
  for (let i = 1; i <= tent; i++) {
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${DEEPSEEK_KEY}` },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          model: 'deepseek-v4-flash', response_format: { type: 'json_object' }, temperature: 0.1,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      })
      if (res.ok) return JSON.parse((await res.json()).choices[0].message.content)
      if (res.status === 429) await new Promise((r) => setTimeout(r, 5000 * i)) // cota: espera mais
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500 * i))
  }
  return null
}

// ⚠️ o schema TEM que ir no prompt: o json_object do DeepSeek garante JSON
// válido, não as NOSSAS chaves (ele não tem responseSchema como o Gemini).
// Sem isto o campo volta undefined e vira falsy — "3 erros" que eram meus.
const SYS_JULGA =
  'Você analisa a transcrição de um INTERVALO COMERCIAL de TV antigo. Recebe a última fala ANTES ' +
  'de uma pausa e a primeira DEPOIS. Diga se é FRONTEIRA entre duas peças (limite=true) ou pausa ' +
  'DENTRO da mesma peça (limite=false). É fronteira quando a fala antes FECHA (assinatura, slogan ' +
  'final, chamada de horário) e a de depois abre outro assunto; ou quando entra/sai vinheta de ' +
  'canal. NÃO é fronteira quando a frase continua atravessando a pausa, nem em ênfase retórica do ' +
  'mesmo anúncio (ex.: sequência de adjetivos). Responda em json com as chaves: limite (boolean), ' +
  'confianca ("alta"|"media"|"baixa"), motivo (string).'

// ⚠️ DUAS listas, e a distinção importa.
//
// PROGRAMAS = o que o Gabriel TEM no ar. Serve pra CASAR: peça que se refere a
// um deles vira promessa da fase 12 (a_seguir/durante) e o agendador cumpre.
//
// GRAFIAS = nomes que aparecem no material de época mas NÃO estão no acervo.
// Serve só pra ORTOGRAFIA. Medido no dry-run: "Cinescópio" é o programa que dá
// nome aos compilados e o whisper escreve "Sinescópio"/"Sinascópio" — saíram
// `com_jetix_cinescopio_volta` E `com_jetix_sinescopio_volta` pro MESMO
// programa, duas famílias de id pra mesma coisa. A lista do Gabriel não pegava
// porque ele passou a programação ATUAL, e o Cinescópio não está no ar hoje.
//
// Misturar as duas seria pior que o bug: o LLM casaria peças com programas que
// o Gabriel não tem, e elas virariam promessas que o agendador não pode cumprir.
const GRAFIAS = ['Cinescópio', 'Beyblade', 'Shaman King', 'Mega Man', 'Medabots', 'Kirby']

const sysNomeia = (canal) =>
  'Você cataloga peças de intervalo de TV brasileira dos anos 2000 (canais retrô). Recebe a ' +
  'transcrição de UMA peça.\nA transcrição é AUTOMÁTICA e erra nomes próprios (ex.: escreve ' +
  '"Sinascópio" ou "Sinescópio" onde se diz "Cinescópio").\n' +
  `GRAFIA CORRETA de nomes que aparecem neste material (use EXATAMENTE assim se a peça se ' +
  'referir a eles, mesmo que a transcrição escreva diferente): ${GRAFIAS.join(' | ')}\n` +
  `PROGRAMAS do acervo: ${PROGRAMAS.join(' | ')}\n` +
  'Se a peça citar programa da lista (mesmo mal transcrito), use a GRAFIA EXATA. Se não estiver, ' +
  'NÃO force nada da lista — use o nome que entender e marque fora_do_acervo=true.\n' +
  'FUNÇÃO (é o que distingue várias peças do MESMO programa): "inicio"=anuncia o que vem ' +
  '("A seguir:", "E agora:") · "saida"=segura pro intervalo ("Voltamos já com", "Não saia daí") · ' +
  '"volta"=identifica o que está no ar ("Você está assistindo", "Continuem vendo") · ' +
  '"anuncio"=publicidade de terceiro · "outro".\n' +
  `NÃO opine sobre o canal: já se sabe que é ${canal}.\n` +
  'Responda em json com as chaves: programa (string), funcao, fora_do_acervo (boolean), ' +
  'detalhe (string max 5 palavras que distingam esta peça), completa (boolean).'

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)

const cache = (nome, fn) => {
  const f = join(WORK, nome)
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
  const v = fn()
  return v instanceof Promise
    ? v.then((r) => { writeFileSync(f, JSON.stringify(r)); return r })
    : (writeFileSync(f, JSON.stringify(v)), v)
}

// ── 1. quais compilados ───────────────────────────────────────────────────
log('lendo o catálogo remoto…')
const compilados = d1(
  `SELECT m.id, ROUND(m.duracao_seg) dur, m.segment_count, mc.channel_id canal,
          COALESCE(json_extract(m.metadata,'$.titulo'), json_extract(m.metadata,'$.title'), '') titulo
   FROM media_items m LEFT JOIN media_channels mc ON mc.media_id = m.id
   WHERE m.tipo='comercial' AND m.status='ready' AND m.duracao_seg >= 140
     AND LOWER(COALESCE(json_extract(m.metadata,'$.titulo'), json_extract(m.metadata,'$.title'), '')) LIKE '%intervalo%'
   ORDER BY m.duracao_seg DESC`)

const idsExistentes = new Set(d1(`SELECT id FROM media_items`).map((r) => r.id))
log(`${compilados.length} compilados · ${idsExistentes.size} ids já no catálogo`)
for (const c of compilados) log(`   ${String(c.dur).padStart(4)}s ${c.canal} · ${c.titulo.slice(0, 50)}`)
if (!compilados.length) { log('nada a fazer'); process.exit(0) }

// ── 2. o laço ─────────────────────────────────────────────────────────────
const relatorio = []
for (const comp of compilados) {
  const tag = comp.id.slice(0, 24)
  const dir = join(WORK, comp.id)
  mkdirSync(dir, { recursive: true })
  const master = join(dir, 'master.mp4')
  try {
    log(`\n━━━ ${tag} (${comp.dur}s, ${comp.canal}) ━━━`)

    // 2a. remonta o master dos .ts do R2 (cache: o arquivo em disco)
    if (!existsSync(master)) {
      log(`  baixando ${comp.segment_count} segmentos do R2…`)
      const lista = []
      for (let i = 0; i < comp.segment_count; i++) {
        const n = String(i).padStart(5, '0')
        const seg = join(dir, `seg${n}.ts`)
        if (!existsSync(seg)) {
          const r = spawnSync('npx', ['wrangler', 'r2', 'object', 'get',
            `biel-tv-media/media/${comp.id}/seg${n}.ts`, '--file', seg, '--remote'],
            { cwd: join(ROOT, 'apps/stream'), stdio: 'ignore' })
          if (r.status !== 0) throw new Error(`falhou baixar seg${n}`)
        }
        lista.push(`file '${seg}'`)
      }
      writeFileSync(join(dir, 'lista.txt'), lista.join('\n'))
      execFileSync(FFMPEG(), ['-hide_banner', '-v', 'error', '-y', '-f', 'concat', '-safe', '0',
        '-i', join(dir, 'lista.txt'), '-c', 'copy', master])
      for (let i = 0; i < comp.segment_count; i++) rmSync(join(dir, `seg${String(i).padStart(5, '0')}.ts`), { force: true })
    }
    const { duration } = await probe(master)

    // 2b. whisper diz QUAIS
    const fala = await cache(`${comp.id}.fala.json`, async () => {
      log('  transcrevendo (o passo caro, ~3min por 600s)…')
      const wav = join(dir, 'a16k.wav')
      execFileSync(FFMPEG(), ['-hide_banner', '-v', 'error', '-y', '-i', master, '-vn', '-ac', '1', '-ar', '16000', wav])
      const out = execFileSync('python3', [join(ROOT, 'scripts/transcreve.py'), wav, '--json'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] })
      rmSync(wav, { force: true })
      return JSON.parse(out)
    })
    const buracos = achaBuracos(fala)
    log(`  ${fala.length} falas · ${buracos.length} buracos candidatos`)

    // ⛔ PORTEIRO DO COMPILADO INTEIRO (2026-07-15, achado no dry-run).
    //
    // A v3 tira os candidatos dos buracos de fala do whisper — e isso só
    // funciona quando o whisper segmenta FINO. Medido nos 6 compilados:
    //   603s → 164 segs, mediana 2.6s, 36 buracos  ← o único que funciona
    //   470s →  99 segs, mediana 4.1s,  6 buracos
    //   390s →  83 segs, mediana 4.0s,  5 buracos
    //   200s →  ...      mediana ~4s,   3 buracos
    // As pausas ESTÃO no áudio (130 silêncios a -30dB no de 470s): o whisper é
    // que não quebra nelas. Segmentação de whisper é comportamento de modelo,
    // varia por arquivo sem avisar.
    //
    // Com poucos candidatos as peças saem de 50-94s. O cap de 90s pega o
    // absurdo, mas NÃO o plausível-e-errado: uma "peça" de 50s pode ser dois
    // anúncios de 25s que ninguém separou — e essa entra no catálogo como se
    // fosse boa. Sem revisor humano, peça plausível-e-errada é o pior caso: ela
    // não grita.
    //
    // Então: densidade de candidatos abaixo do piso ⇒ NÃO CORTA este compilado.
    // Ele fica intacto e no ar (status quo), esperando a correção da fonte de
    // candidatos (silêncio ∪ buraco) ser testada contra gabarito. Descartar é
    // grátis; ingerir peça quebrada, não.
    const densidade = buracos.length / (duration / 60) // candidatos por minuto
    const MIN_DENSIDADE = 2.5 // o de 603s tem 3.6/min; os quebrados, 0.8-1.0/min
    if (densidade < MIN_DENSIDADE) {
      log(`  ⛔ PULADO: só ${densidade.toFixed(1)} candidatos/min (piso ${MIN_DENSIDADE}) — ` +
        `o whisper segmentou grosso (mediana ${(fala.reduce((a, s) => a + (s.end - s.start), 0) / fala.length).toFixed(1)}s) ` +
        `e as peças sairiam de 50-94s sem ninguém pra conferir. Original CONTINUA no ar.`)
      relatorio.push({
        compilado: comp.id, titulo: comp.titulo, dur: comp.dur, pulado: true,
        motivo: `densidade de candidatos ${densidade.toFixed(1)}/min < ${MIN_DENSIDADE} — fonte de candidatos (buraco de fala) não serve pra este arquivo`,
        buracos: buracos.length, falas: fala.length,
      })
      continue
    }

    // 2c. o LLM diz SE (13/13 medido contra gabarito anotado à mão)
    const vered = await cache(`${comp.id}.julga.json`, async () => {
      log(`  julgando ${buracos.length} buracos no DeepSeek…`)
      const out = []
      for (const b of buracos) {
        const j = await ds(SYS_JULGA, `Pausa de ${b.dur.toFixed(1)}s.\nANTES: "${b.textoAntes}"\nDEPOIS: "${b.textoDepois}"\nResponda em json.`)
        out.push(Boolean(j?.limite))
      }
      return out
    })
    log(`  ${vered.filter(Boolean).length} buracos são limite`)

    // 2d. a MARGEM diz ONDE (o ffmpeg só ancora em ~1/3 — medido)
    const [s30, s24, preto, cena] = await Promise.all([
      detectSilence(master, { noise: -30, d: 0.25 }),
      detectSilence(master, { noise: -24, d: 0.25 }),
      detectBlack(master, { d: 0.15 }),
      detectScene(master, { th: 0.4 }),
    ])
    const sinais = { silencio_30db: s30, silencio_24db: s24, preto, cena }
    const pontos = []
    let blocos = 0
    for (const [i, b] of buracos.entries()) {
      if (!vered[i]) continue
      const a = ancoraCorte(b, sinais)
      if (a.t === null) { blocos++; continue } // bloco sem locução: não corta no escuro
      pontos.push(a.t)
    }
    pontos.sort((x, y) => x - y)

    // 2e. peças, remontando o que o corte quebrou
    let pecas = []
    for (let i = 0; i <= pontos.length; i++) {
      const ini = i === 0 ? 0 : pontos[i - 1]
      const fim = i === pontos.length ? duration : pontos[i]
      if (fim - ini < 0.1) continue
      pecas.push({ ini, fim, dur: Math.round((fim - ini) * 100) / 100 })
    }
    pecas = fundePelaGrade(pecas)
    const entram = pecas.filter((p) => classificaPeca(p).ok)
    log(`  ${pecas.length} peças (${pecas.filter((p) => p.fundido).length} remontadas, ${blocos} blocos recusados) · ${entram.length} entram`)

    // 2f. nomeia (vocabulário do acervo: sem ele o LLM herda o erro do whisper)
    const nomes = await cache(`${comp.id}.nomes.json`, async () => {
      const out = []
      for (const p of entram) {
        const txt = fala.filter((f) => f.start >= p.ini - 0.3 && f.end <= p.fim + 0.3).map((f) => f.text).join(' ')
        if (txt.trim().length < 8) { out.push(null); continue } // muda: nome sai da imagem → fila "A nomear"
        const j = await ds(sysNomeia(comp.canal), `Peça de ${p.dur.toFixed(0)}s do canal ${comp.canal}. Transcrição:\n"""${txt.slice(0, 1200)}"""\nResponda em json.`)
        out.push(j)
      }
      return out
    })

    // 2g. corta e ingere
    const feitas = []
    for (const [i, p] of entram.entries()) {
      const j = nomes[i]
      const f = j?.funcao ?? 'outro'
      // ⚠️ o LLM devolve "Desconhecido"/"N/A" literal quando não sabe, e isso
      // vazava pro nome E pro id (saiu um `com_jetix_desconhecido` no lote de
      // 2026-07-15). Um id chamado "desconhecido" é pior que um genérico: ele
      // colide com o próximo desconhecido e não diz nada. Trata como vazio.
      const VAZIO = /^(desconhecid[oa]|n\/?a|indefinid[oa]|sem nome|unknown|)$/i
      const prog = VAZIO.test((j?.programa ?? '').trim()) ? '' : j.programa.trim()
      const det = VAZIO.test((j?.detalhe ?? '').trim()) ? '' : j.detalhe.trim()
      const nome = [comp.canal, prog || null, (f !== 'outro' && f !== 'anuncio') ? f : null, det || null]
        .filter(Boolean).join(' · ') || `${comp.canal} · peça ${i} de ${comp.titulo}`.slice(0, 60)
      const base = ['com', slug(comp.canal), slug(prog || det || `p${i}`), f !== 'outro' ? f : null]
        .filter(Boolean).join('_')
      const id = resolveId(base, idsExistentes)
      idsExistentes.add(id) // ⚠️ reservar JÁ: senão a próxima peça colide com esta

      if (DRY) { log(`  · [dry] ${id}  (${p.dur}s)  "${nome}"`); feitas.push({ id, nome, dur: p.dur }); continue }
      const out = join(dir, `peca${i}.mp4`)
      await extraiTrecho(master, p.ini, p.fim, out) // -ss DEPOIS do -i: frame-accurate
      const r = spawnSync(process.execPath, ['--dns-result-order=ipv4first',
        join(ROOT, 'packages/pipeline/src/cli.mjs'), 'ingest', out,
        '--id', id, '--tipo', 'comercial', '--title', nome,
        '--canais', comp.canal, '--target', 'remote', '--base-url', '',
        // nasce FORA do ar: peça recortada é palpite até o Gabriel aprovar
        '--status', 'disabled'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
      rmSync(out, { force: true })
      if (r.status !== 0) {
        log(`  ✖ ${id}: ${String(r.stderr || r.stdout).trim().split('\n').at(-1)?.slice(0, 120)}`)
        continue
      }
      feitas.push({ id, nome, dur: p.dur, fundido: Boolean(p.fundido) })
      log(`  ✔ ${id} (${p.dur}s)${p.fundido ? ' [remontada]' : ''} — ${nome}`)
    }

    // 2h. o original sai do ar — SÓ agora, e só se as peças entraram
    let desativado = false
    if (!DRY && feitas.length > 0) {
      d1(`UPDATE media_items SET status='disabled' WHERE id='${comp.id}'`)
      desativado = true
      log(`  ⏻ original desativado (sai do rodízio; arquivo e .ts continuam no R2)`)
    } else if (!DRY) {
      log(`  ⚠ nenhuma peça entrou — original CONTINUA no ar de propósito`)
    }
    relatorio.push({ compilado: comp.id, titulo: comp.titulo, dur: comp.dur, candidatas: pecas.length, entraram: feitas.length, blocos, desativado, pecas: feitas })
    // no dry-run o master FICA: o run real reusa e não re-baixa 107MB do R2.
    // (o cache de fala/julga/nomes é o que economiza a noite; o master é o
    //  insumo deles, e re-baixar 6 compilados custaria ~20min à toa)
    if (!DRY) rmSync(master, { force: true })
  } catch (e) {
    log(`  ✖ ${tag} FALHOU: ${String(e.message ?? e).slice(0, 200)}`)
    relatorio.push({ compilado: comp.id, erro: String(e.message ?? e).slice(0, 200) })
  }
}

// ── 3. relatório ──────────────────────────────────────────────────────────
const rel = join(WORK, `relatorio-${DRY ? 'dry' : 'real'}.json`)
writeFileSync(rel, JSON.stringify(relatorio, null, 1))
console.log(`\n${'═'.repeat(60)}`)
let tot = 0
for (const r of relatorio) {
  if (r.erro) { console.log(`✖ ${String(r.dur ?? '').padStart(4)}s ${r.compilado.slice(0, 30).padEnd(31)} → ERRO: ${r.erro.slice(0, 60)}`); continue }
  // pulado não tem `entraram` — somar undefined contaminava o total com NaN
  if (r.pulado) { console.log(`⛔ ${String(r.dur).padStart(4)}s ${r.compilado.slice(0, 30).padEnd(31)} → PULADO: ${r.motivo.slice(0, 52)}`); continue }
  tot += r.entraram ?? 0
  console.log(`${r.desativado ? '⏻' : ' '} ${String(r.dur).padStart(4)}s ${r.compilado.slice(0, 30).padEnd(31)} → ${String(r.entraram).padStart(2)}/${r.candidatas} peças`)
}
console.log(`${'═'.repeat(60)}\n⇒ ${tot} peças no catálogo${DRY ? ' (DRY-RUN: nada foi escrito)' : ''}\n   relatório: ${rel}\n`)
