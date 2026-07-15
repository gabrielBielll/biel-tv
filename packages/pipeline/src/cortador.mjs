// Cortador de comerciais: 1 compilado → N anúncios. A playlist AO CONTRÁRIO.
// Spec: docs/features/cortador-comerciais.md
//
// ⚠️ Este arquivo tem DOIS motores. O v3 (que serve) está no FIM, na seção
//    "MOTOR v3". O v1 abaixo está morto e explicado — a autópsia vale a leitura
//    porque é o registro de como 4 premissas confiantes caíram uma a uma.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⛔ O MOTOR v1 (ABAIXO) NÃO SERVE PRO ACERVO REAL. NÃO CONSTRUA NELE.     │
// │                                                                         │
// │ Ele passa 29/29 no verify — contra um compilado que o TESTE FABRICA,    │
// │ plantando preto+silêncio nos limites porque a spec dizia que era assim  │
// │ que comercial emenda. Rodado no acervo de verdade (Jetix Intervalo      │
// │ Comercial, 600s, reconstruído do R2), REPROVOU 100% dos candidatos:     │
// │                                                                         │
// │  · preto: 4 ocorrências em 600s — e o único perto de um limite estava   │
// │    DENTRO de um anúncio (entre "grande!/enorme!/gigante!"). Cortar ali  │
// │    picotaria um comercial em quatro. `portaoSinal()` exige preto ∩      │
// │    silêncio: é a premissa errada, codificada.                           │
// │  · platô: NÃO EXISTE em áudio real. O sweep decai monotonicamente       │
// │    (434 gaps a -18dB → 6 a -50dB) porque áudio de broadcast é           │
// │    comprimido: não há silêncio entre peças, só o fundo de um            │
// │    decaimento. O platô só existe onde a transição é instantânea — ou    │
// │    seja, em áudio sintético. `achaThreshold()` mede uma propriedade     │
// │    que o material não tem.                                              │
// │                                                                         │
// │ SOBREVIVEM (ver "O que se APROVEITA" na spec): fundeZonas() — o modelo  │
// │ de zona morta está certo e foi medido (invasão ≤ 1 frame, o piso        │
// │ físico); segmenta(); portaoGrade() — o único portão que resistiu ao     │
// │ real; extraiTrecho(); detectSilence() como REFINADOR de timestamp       │
// │ (±15ms) de um limite já confirmado por outro sinal.                     │
// │                                                                         │
// │ A v3 inverte: whisper diz QUAIS (buraco de fala = candidato), o LLM diz │
// │ SE (o texto fechou com a marca?), o ffmpeg diz ONDE (±15ms).            │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Regra da casa (diretor.ts:2): o LLM DECIDE, o CÓDIGO CALCULA. Este módulo é
// a metade "código calcula" — medição e aritmética, zero julgamento, 100%
// reprodutível. Os portões que precisam de julgamento (visual/semântico) são
// LLM e moram fora daqui.
//
// O princípio que sustenta a feature: o Gabriel NÃO revisa. Então o sistema
// precisa saber quando ele NÃO SABE, e desistir sozinho em vez de chutar.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG, detectBlack, detectSilence, detectScene, volumeMedio, probe } from './ffmpeg.mjs'

const execFileAsync = promisify(execFile)
const BUF = { maxBuffer: 64 * 1024 * 1024 }

// ── constantes (as "decisões abertas" da spec, num lugar só) ───────────────
export const SWEEP_MIN = -50 // dB — piso da varredura
export const SWEEP_MAX = -18 // dB — teto
export const PLATO_MIN = 4 // dB — platô mais estreito que isto = não confiável
export const W_FUSAO = 0.5 // s — janela de clusterização
export const GRADE = [15, 30, 60] // s — slots de comercial de TV
export const GRADE_TOL = 1.5 // s — tolerância da grade
export const D_SILENCIO = 0.3 // s
export const D_PRETO = 0.15 // s — ⚠️ NÃO é o 1.0 do cue point (ver detectBlack)
export const BORDA_CONTEUDO_DB = -50 // acima disto, a borda tem áudio de verdade

/** Áudio pro wav uma vez só: o sweep roda ~30 passadas e decodificar o
 *  compilado inteiro em cada uma custaria minutos à toa. */
async function extraiAudio(file, outWav) {
  await execFileAsync(FFMPEG(), [
    '-hide_banner', '-y', '-i', file,
    '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '1', outWav,
  ], BUF)
  return outWav
}

/**
 * Dois thresholds "concordam" quando enxergam a MESMA ESTRUTURA: o mesmo número
 * de gaps, cada um no mesmo lugar dentro de `tol`.
 *
 * ⚠️ NÃO comparar timestamp exato (foi assim na 1ª versão, e quebrou no
 * primeiro arquivo real). Em áudio de verdade o som DECAI em vez de cortar
 * feito parede: quanto mais baixo o threshold, mais tarde ele cruza. Medido num
 * rip real do Jetix — o mesmo gap aparece em 9.73 (-20dB), 9.78 (-22dB) e 9.79
 * (-24dB). A deriva é física do som, não ruído; exigir dígito igual só funciona
 * em áudio sintético (onde a transição é instantânea) e rejeita todo compilado
 * de verdade. O que é estável — e o que a feature precisa — é a ESTRUTURA.
 */
const TOL_PLATO = 0.25 // s — deriva aceitável de um gap ao longo do platô

function mesmaEstrutura(a, b, tol = TOL_PLATO) {
  if (a.length !== b.length || a.length === 0) return false
  return a.every((g, i) =>
    Math.abs(g.start - b[i].start) <= tol && Math.abs(g.end - b[i].end) <= tol)
}

/**
 * ⭐ O CORAÇÃO: descobre o noise floor MEDINDO, em vez de chutar.
 *
 * Entre dois anúncios o áudio cai — mas "cai pra quanto" depende do chiado do
 * arquivo (rip de VHS chia; upload limpo não). Um threshold fixo é o jeito nº 1
 * de não achar NADA: medido num arquivo com hiss a -34dB, o silencedetect a
 * -30dB acha os gaps com erro de ~15ms e a -40dB acha ZERO.
 *
 * A saída é binária e barulhenta, nunca sutil — e é isso que autoriza rodar sem
 * revisor: existe uma faixa de dB (o PLATÔ) onde o resultado não muda um dígito.
 * Acha-se o platô e usa-se o meio dele.
 *
 * @returns {{db, plato:{min,max}, largura, gaps}} ou `null` = compilado
 *   REJEITADO (sem resposta estável; o Gabriel cola outro link, custa zero).
 */
export async function achaThreshold(file, { d = D_SILENCIO } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'cort-'))
  try {
    const wav = await extraiAudio(file, join(tmp, 'a.wav'))
    const amostras = []
    for (let db = SWEEP_MAX; db >= SWEEP_MIN; db--) {
      amostras.push({ db, gaps: await detectSilence(wav, { noise: db, d }) })
    }

    // Maior faixa contígua que enxerga a mesma estrutura. A comparação é sempre
    // contra a ÂNCORA (o topo da faixa), nunca contra o vizinho: comparando de
    // vizinho em vizinho, uma deriva de 0.05s por dB passaria despercebida e
    // acumularia sem limite ao longo de 10dB.
    //
    // ⚠️ Estrutura VAZIA não conta como platô: abaixo do piso de ruído TODOS os
    // thresholds acham zero gaps e formariam um "platô" larguíssimo de nada —
    // que é justamente o caso a rejeitar, não a escolher. (No rip real do Jetix:
    // -26dB a -50dB = 25dB contíguos de zero.)
    let melhor = null
    for (let i = 0; i < amostras.length;) {
      let j = i
      while (j + 1 < amostras.length && mesmaEstrutura(amostras[i].gaps, amostras[j + 1].gaps)) j++
      const largura = amostras[i].db - amostras[j].db + 1
      if (amostras[i].gaps.length > 0 && (!melhor || largura > melhor.largura)) {
        melhor = { largura, hi: amostras[i].db, lo: amostras[j].db, gaps: amostras[i].gaps }
      }
      i = j + 1
    }

    if (!melhor || melhor.largura < PLATO_MIN) return null
    // O meio do platô: o ponto mais longe das duas bordas onde o resultado muda.
    const db = Math.round((melhor.hi + melhor.lo) / 2)
    return {
      db,
      plato: { min: melhor.lo, max: melhor.hi },
      largura: melhor.largura,
      gaps: await detectSilence(wav, { noise: db, d }),
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Funde os sinais em ZONAS MORTAS.
 *
 * Um limite entre anúncios NÃO é um ponto: é um gap (preto+silêncio, 0.2–1s) e
 * qualquer instante dentro dele é um corte correto. Modelar como zona (dois
 * pontos) e não como ponto médio faz o erro de detecção cair no preto em vez de
 * cair no conteúdo — o anúncio A termina no último frame DELE e o B começa no
 * primeiro frame DELE; o gap não pertence a ninguém.
 *
 * A zona é a INTERSEÇÃO dos sinais (`max` dos starts, `min` dos ends): o
 * pedaço onde TODOS concordam que não tem nada. Fora dela ainda pode haver
 * conteúdo — se o áudio calou em 9.9 mas a imagem só apagou em 10.0, o vídeo do
 * anúncio A vai até 10.0.
 *
 * Cena entra só como CONFIRMAÇÃO (é um ponto, não um intervalo — não participa
 * da interseção, senão zeraria a zona).
 */
export function fundeZonas(pretos, silencios, cenas, { w = W_FUSAO } = {}) {
  const itens = [
    ...pretos.map((z) => ({ ...z, sinal: 'preto' })),
    ...silencios.map((z) => ({ ...z, sinal: 'silencio' })),
  ].sort((a, b) => a.start - b.start)

  const clusters = []
  for (const it of itens) {
    const ult = clusters[clusters.length - 1]
    // mesmo cluster se sobrepõe ou está a menos de W de distância
    if (ult && it.start <= ult.fim + w) {
      ult.itens.push(it)
      ult.fim = Math.max(ult.fim, it.end)
    } else {
      clusters.push({ itens: [it], fim: it.end })
    }
  }

  return clusters.map((c) => {
    const gapStart = Math.max(...c.itens.map((i) => i.start))
    const gapEnd = Math.min(...c.itens.map((i) => i.end))
    const sinais = [...new Set(c.itens.map((i) => i.sinal))]
    // Interseção vazia (os sinais se tocam mas não se sobrepõem): cai pro
    // ponto médio do cluster — vira zona degenerada, e o portão de sinal
    // decide se ela sobrevive.
    const vazia = gapStart >= gapEnd
    const meio = (Math.min(...c.itens.map((i) => i.start)) + Math.max(...c.itens.map((i) => i.end))) / 2
    const zona = vazia ? { gapStart: meio, gapEnd: meio } : { gapStart, gapEnd }
    // cena não entra na interseção, só confirma
    if (cenas.some((t) => t >= zona.gapStart - w && t <= zona.gapEnd + w)) sinais.push('cena')
    return { ...zona, sinais }
  })
}

/** Zonas → candidatos. O trecho vai do fim de uma zona ao início da próxima. */
export function segmenta(zonas, duracao) {
  const cands = []
  const zs = [...zonas].sort((a, b) => a.gapStart - b.gapStart)
  for (let i = 0; i <= zs.length; i++) {
    const start = i === 0 ? 0 : zs[i - 1].gapEnd
    const end = i === zs.length ? duracao : zs[i].gapStart
    if (end <= start) continue
    cands.push({
      i: cands.length,
      start,
      end,
      dur: end - start,
      // sinais dos DOIS limites que delimitam o trecho
      limiteEsq: i === 0 ? null : zs[i - 1].sinais,
      limiteDir: i === zs.length ? null : zs[i].sinais,
      borda: i === 0 || i === zs.length,
    })
  }
  return cands
}

// ── portões determinísticos ────────────────────────────────────────────────
// Cada um devolve `null` (passou) ou o motivo da recusa. Cinco portões
// independentes erram de formas diferentes — é esse o ponto. Os três daqui são
// aritmética; os outros dois (visual/semântico) são LLM e ficam na fábrica.

/** Portão 1 — o limite é REAL? Preto ∩ silêncio nos dois lados. Sinal solto
 *  não basta. Borda do compilado só tem um limite → não dá pra validar. */
export function portaoSinal(c) {
  if (c.borda) return 'borda do compilado (vinheta/intro do canal; um limite só)'
  for (const [lado, sinais] of [['esquerdo', c.limiteEsq], ['direito', c.limiteDir]]) {
    if (!sinais.includes('preto') || !sinais.includes('silencio')) {
      return `limite ${lado} fraco (${sinais.join('+') || 'nenhum'}): preto ∩ silêncio é obrigatório`
    }
  }
  return null
}

/**
 * Portão 2 — o mais forte, e o único INDEPENDENTE do ffmpeg.
 * Comercial de TV é vendido em slot de 15/30/60s. Se o trecho deu 29.8s, os
 * DOIS limites estão certos — e essa confirmação não vem de medir o arquivo,
 * vem de como o mundo funciona. Fora da grade = algum limite está errado.
 */
export function portaoGrade(c, { grade = GRADE, tol = GRADE_TOL } = {}) {
  const alvo = grade.find((g) => Math.abs(c.dur - g) <= tol)
  if (!alvo) return `duração ${c.dur.toFixed(1)}s fora da grade ${grade.join('/')}s (±${tol}s)`
  c.slot = alvo
  return null
}

/** Portão 3 — o detector conferindo o próprio resultado: o clipe COMEÇA e
 *  TERMINA no conteúdo? Se abre com silêncio, o corte vazou pra dentro do gap. */
export async function portaoBorda(file, c, { janela = 0.25 } = {}) {
  const ini = await volumeMedio(file, c.start, janela)
  const fim = await volumeMedio(file, Math.max(c.start, c.end - janela), janela)
  if (ini < BORDA_CONTEUDO_DB) return `começa em silêncio (${ini.toFixed(1)}dB): o corte vazou pro gap`
  if (fim < BORDA_CONTEUDO_DB) return `termina em silêncio (${fim.toFixed(1)}dB): o corte vazou pro gap`
  return null
}

/**
 * Orquestra a parte determinística: mede → funde → segmenta → portões 1-3.
 *
 * A assimetria que justifica descartar sem dó: jogar fora um comercial bom
 * custa ~zero (tem compilado infinito no YouTube, é só colar outro link);
 * ingerir um cortado no meio bota peça quebrada no ar, e ninguém confere.
 * 5 aprovados de 9 candidatos é SUCESSO, não desperdício.
 *
 * @returns {{rejeitado?, motivo?, threshold?, plato?, candidatos?}}
 */
export async function analisaCompilado(file, opts = {}) {
  const dur = opts.duracao ?? (await probe(file)).duration
  if (!dur) return { rejeitado: true, motivo: 'não foi possível medir a duração do compilado' }

  const th = await achaThreshold(file)
  if (!th) {
    return {
      rejeitado: true,
      motivo: `sem platô de silêncio (nenhuma faixa de ${PLATO_MIN}dB dá resultado estável) — ` +
        'este compilado não tem limites confiáveis; cole outro link',
    }
  }

  const [pretos, cenas] = await Promise.all([
    detectBlack(file, { d: D_PRETO }), // ⚠️ NÃO o default 1.0 (é cue point de intervalo)
    detectScene(file),
  ])
  const zonas = fundeZonas(pretos, th.gaps, cenas)
  const candidatos = segmenta(zonas, dur)

  for (const c of candidatos) {
    c.recusa = portaoSinal(c) ?? portaoGrade(c, opts)
    if (!c.recusa) c.recusa = await portaoBorda(file, c)
    c.aprovado = !c.recusa
  }

  return {
    rejeitado: false,
    threshold: th.db,
    plato: th.plato,
    platoLargura: th.largura,
    zonas,
    candidatos,
    aprovados: candidatos.filter((c) => c.aprovado).length,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MOTOR v3 — o que serve. Spec: docs/features/cortador-comerciais.md
//
// Divisão de trabalho, cada peça só no que sabe (e cada uma MEDIDA no acervo
// real antes de virar código — ver os números em cada função):
//
//   whisper diz QUAIS  → buraco de fala = candidato a limite
//   o LLM diz SE       → o texto das bordas decide (13/13 medido, no Worker)
//   a MARGEM diz ONDE  → o ffmpeg só ancora no 1/3 das vezes em que tem o quê
//
// A margem é ideia do Gabriel ("aproveitar o fim da vinheta e deixar alguns
// segundos a mais, no máximo 5"), e a medição depois explicou por que funciona:
// o limite NUNCA está no meio do vazio, está grudado no fim da fala. Comercial
// fecha com a marca, sobram 1-2s de trilha/cartela, entra a próxima peça.
// ═══════════════════════════════════════════════════════════════════════════

export const MIN_BURACO = 0.8 // s — pausa menor que isto é respiro, não limite
export const MARGEM_MAX = 5.0 // s — teto do Gabriel: passou disto, já se está
//                                   DENTRO da peça seguinte, não no rabicho dela

/**
 * Buracos de fala = os candidatos. Só isto: quem decide se é limite é o LLM
 * (texto das bordas), e este módulo não opina.
 *
 * @param fala `[{start,end,text}]` — do `transcreve.py --json`.
 */
export function achaBuracos(fala, { minGap = MIN_BURACO } = {}) {
  const out = []
  for (let i = 0; i < fala.length - 1; i++) {
    const ini = fala[i].end
    const fim = fala[i + 1].start
    if (fim - ini < minGap) continue
    out.push({
      n: out.length + 1,
      ini, fim,
      dur: Math.round((fim - ini) * 100) / 100,
      textoAntes: fala[i].text,
      textoDepois: fala[i + 1].text,
    })
  }
  return out
}

/**
 * ⭐ A ESCADA DA PRECISÃO — onde cortar, dado um buraco já confirmado como limite.
 *
 * Medido nos 25 limites do compilado real: só **8 têm âncora limpa**, 11 são
 * ambíguos (o buraco tem 3, 4, até 27 silêncios dentro) e 6 não têm nada. Ou
 * seja: a promessa "o ffmpeg dá ±15ms" vale em 1/3 dos casos. Os ±15ms foram
 * medidos num limite cuja posição já se sabia — que é justamente o que não se
 * sabe aqui.
 *
 * Mas o estrago é menor do que parece: metade dos buracos tem 1–1.5s, e cortar
 * no meio erra ≤0.75s DE MÚSICA DE TRANSIÇÃO, não de conteúdo. O problema real
 * é o buraco longo (12s, 91s), e para esse o degrau 4 recusa em vez de chutar.
 *
 * @returns {{t, zona, metodo, precisao}} ou `{t:null, metodo:'bloco'}` = não
 *   cortar (bloco sem locução: promo/comercial mudo — deixa a grade decidir).
 */
export function ancoraCorte(buraco, sinais, { margem = MARGEM_MAX } = {}) {
  // Silêncios que caem DENTRO do buraco. Preferir o floor mais alto (-24dB
  // pegou 28 no trecho contra 10 do -30dB): áudio de broadcast é comprimido, o
  // "silêncio" real é raso. Se o mais alto der ambíguo, o mais fundo desempata.
  const dentro = (arr) => (arr ?? []).filter((s) => s.end >= buraco.ini && s.start <= buraco.fim)
  const zonaDe = (s) => ({ gapStart: Math.max(s.start, buraco.ini), gapEnd: Math.min(s.end, buraco.fim) })

  for (const arr of [sinais.silencio_30db, sinais.silencio_24db]) {
    const ss = dentro(arr)
    // ── degrau 1: âncora limpa (8 dos 25) ──
    if (ss.length === 1) {
      const z = zonaDe(ss[0])
      return { t: z.gapStart, zona: z, metodo: 'silencio', precisao: 0.033 }
    }
    // ── degrau 2: vários → o PRIMEIRO depois do fim da fala, dentro da margem.
    // (não o maior, nem o do meio: o limite está grudado na ponta) ──
    if (ss.length > 1) {
      const cand = ss.filter((s) => s.start >= buraco.ini && s.start <= buraco.ini + margem)
      if (cand.length) {
        const z = zonaDe(cand[0])
        return { t: z.gapStart, zona: z, metodo: 'silencio-margem', precisao: 0.25 }
      }
    }
  }

  // ── degrau 4 (antes do 3, porque recusar tem prioridade): buraco longo sem
  // âncora = bloco sem locução. NÃO cortar no escuro — cortar no meio de um
  // buraco de 91s erraria 45s. Foi assim que a promo institucional apareceu. ──
  if (buraco.dur > margem) {
    return { t: null, metodo: 'bloco', motivo: `buraco de ${buraco.dur}s sem âncora: bloco sem locução (promo/mudo?) — a grade decide` }
  }

  // ── degrau 3: nada, mas o buraco é curto → fim da fala + margem, limitado
  // pelo próprio buraco. Erro ≤ dur/2, e o que está aí é trilha. ──
  const t = buraco.ini + Math.min(buraco.dur / 2, margem)
  return { t, zona: { gapStart: t, gapEnd: t }, metodo: 'margem', precisao: buraco.dur / 2 }
}
