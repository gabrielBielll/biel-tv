import { SEG } from './ffmpeg.mjs'

/**
 * Converte trechos de preto em cue points na grade de 10s.
 * No modelo "live virtual", comercial só entra em fronteira de segmento —
 * então o black_start é arredondado para o múltiplo de 10 mais próximo
 * (erro máximo de ±5s, invisível na prática).
 * minEdge descarta cortes cedo/tarde demais na mídia.
 */
export function snapCuePoints(blacks, { duration, minEdge = 60 }) {
  const cues = new Set()
  for (const b of blacks) {
    const cue = Math.round(b.start / SEG) * SEG
    if (cue >= minEdge && cue <= duration - minEdge) cues.add(cue)
  }
  return [...cues].sort((a, b) => a - b)
}

/**
 * Cue points a partir de SILÊNCIO — o plano B de quem não tem tela preta.
 *
 * Por que existe: medido em 21/09/2026, 45–57% do acervo não tem NENHUM cue
 * point (rip de YouTube costuma perder o fade-to-black). Sem ponto de corte o
 * scheduler não consegue partir o episódio, e os ~8min que sobram num slot de
 * 30min desabam num bloco sólido de comercial antes da âncora. Medição por
 * canal: Jetix e Disney conseguiam 1,5min de comercial DISTRIBUÍDO por
 * episódio; o resto virava bloco.
 *
 * A regra que protege o telespectador: o corte cai **dentro de um silêncio de
 * verdade**, no MEIO dele — nunca num instante do relógio. Um silêncio de ≥1s
 * no meio de um desenho é fim de cena/ato, que é onde a emissora cortava. Isso
 * responde ao medo (justo) de "cortar num momento ruim": não se inventa corte,
 * escolhe-se entre os que o áudio ofereceu.
 *
 * Escolha gulosa pelo silêncio MAIS LONGO que ainda respeite o espaçamento —
 * silêncio longo é o sinal mais forte de fim de ato. O espaçamento default é o
 * mesmo MIN_ENTRE_PODS do scheduler (300s): cue mais junto que isso seria
 * descartado na hora de montar a grade, então nem vira cue point.
 *
 * @param {{start:number,end:number}[]} gaps trechos de silêncio (detectSilence)
 * @param {{duration:number, minEdge?:number, alvo?:number, espaco?:number, minGap?:number}} opts
 * @returns {number[]} cue points em segundos, múltiplos de SEG, ordenados
 */
export function cuesDeSilencio(gaps, { duration, minEdge = 60, alvo = 4, espaco = 300, minGap = 1 } = {}) {
  const candidatos = []
  for (const g of gaps) {
    const dur = g.end - g.start
    if (dur < minGap) continue
    // o corte cai no MEIO do silêncio: é o ponto mais longe da fala dos dois lados
    const cue = Math.round((g.start + dur / 2) / SEG) * SEG
    if (cue < minEdge || cue > duration - minEdge) continue
    candidatos.push({ cue, dur })
  }
  // silêncio mais longo primeiro (sinal mais forte); empate pelo mais cedo
  candidatos.sort((a, b) => b.dur - a.dur || a.cue - b.cue)
  const escolhidos = []
  for (const c of candidatos) {
    if (escolhidos.length >= alvo) break
    if (escolhidos.some((e) => Math.abs(e - c.cue) < espaco)) continue
    escolhidos.push(c.cue)
  }
  return escolhidos.sort((a, b) => a - b)
}

/**
 * Funde as TRÊS fontes por prioridade: PRETO (fade real do episódio) → SILÊNCIO
 * (pausa medida no áudio) → CENA (emenda entre planos). Cada fonte só entra
 * onde a anterior não cobriu, respeitando o mesmo espaçamento do scheduler.
 *
 * O `alvo` limita as fontes DERIVADAS, não o preto: um fade-to-black é o
 * próprio episódio dizendo onde é o intervalo, então nunca se joga um fora por
 * cota. Episódio com 5 fades reais fica com os 5 — o scheduler aplica o
 * espaçamento dele na hora de montar a grade e usa os que couberem.
 */
export function fundeCues(pretos, silencios, cenas = [], { alvo = 4, espaco = 300 } = {}) {
  const out = pretos.map((t) => ({ t, kind: 'black' }))
  const junta = (lista, kind) => {
    for (const t of lista) {
      if (out.length >= alvo) return
      if (out.some((e) => Math.abs(e.t - t) < espaco)) continue
      out.push({ t, kind })
    }
  }
  junta(silencios, 'silencio')   // 2ª: pausa real do áudio
  junta(cenas, 'cena')           // 3ª: emenda entre planos
  return out.sort((a, b) => a.t - b.t)
}

/**
 * Escolhe o piso de dB pra procurar silêncio de CUE POINT.
 *
 * Por que não reusar o `achaThreshold()` do cortador: ele exige um PLATÔ (faixa
 * de dB onde o resultado não muda), e isso é certo pro trabalho dele — cortar
 * um comercial no lugar errado estraga a peça. Desenho tem trilha sonora do
 * começo ao fim, então a curva de silêncio é CONTÍNUA e nunca forma platô.
 * Medido no EP03 do SPD: -20dB→82 gaps, -25→34, -30→14, -35→10, -40→4, -50→2.
 * Sem platô, o cortador devolve null e a gente ficaria com zero cue point.
 *
 * Aqui o critério é outro, porque o erro tolerável é outro: o cue já é
 * arredondado pra grade de 10s (±5s, "invisível na prática" — ver snapCuePoints).
 * Então pegamos o piso MAIS FUNDO (= mais silencioso = mais seguro) que ainda
 * ofereça `alvo` silêncios. Fundo demais não acha nada; raso demais começa a
 * chamar de "silêncio" a pausa entre duas falas — por isso o TETO.
 *
 * @param {{db:number, gaps:{start:number,end:number}[]}[]} amostras varredura, do mais fundo pro mais raso
 * @param {{alvo?:number, teto?:number}} opts teto = dB acima do qual não se confia
 * @returns {{db:number, gaps:object[]}|null} null = o áudio não oferece silêncio suficiente
 */
export function escolhePiso(amostras, { alvo = 4, teto = -35 } = {}) {
  const validas = amostras.filter((a) => a.db <= teto).sort((a, b) => a.db - b.db)
  for (const a of validas) if (a.gaps.length >= alvo) return a
  // nenhum piso dá o alvo cheio: fica com o que tem MAIS silêncios (ainda real,
  // só menos intervalos) — melhor 2 cortes bons que 4 inventados
  const melhor = validas.reduce((m, a) => (!m || a.gaps.length > m.gaps.length ? a : m), null)
  return melhor && melhor.gaps.length > 0 ? melhor : null
}

/**
 * Cue points a partir de TROCA DE CENA — o corte que o telespectador não sente.
 *
 * É a terceira e melhor fonte quando não há fade-to-black nem silêncio. Medido
 * no EP03 do SPD (22:37, sem preto e sem silêncio útil): 490 trocas de cena,
 * 424 na janela válida — e a troca mais próxima de cada ponto ideal caiu a 2s,
 * 0s, 4s e 6s do alvo. Ou seja: dá pra ter intervalo BEM espaçado e ainda assim
 * cortar sempre na emenda entre dois planos.
 *
 * Isto é o oposto de cortar pelo relógio: o relógio cai no meio de uma fala ou
 * de um movimento; a troca de cena é onde o próprio episódio já mudou de
 * assunto. Foi o medo (justo) do Gabriel em 21/09 que trouxe esta fonte.
 *
 * Estratégia: para cada ponto IDEAL (espaçados por `espaco`), pega a troca de
 * cena mais PRÓXIMA dele que ainda respeite o espaçamento das já escolhidas.
 * Se a mais próxima estiver longe demais (`tolerancia`), prefere não cortar —
 * um intervalo a menos é melhor que um intervalo no lugar errado.
 *
 * @param {number[]} cenas instantes de troca de cena (detectScene)
 * @param {{duration:number, minEdge?:number, alvo?:number, espaco?:number, tolerancia?:number}} opts
 * @returns {number[]} cue points em segundos, múltiplos de SEG, ordenados
 */
export function cuesDeCena(cenas, { duration, minEdge = 60, alvo = 4, espaco = 300, tolerancia = 90 } = {}) {
  const uteis = cenas.filter((t) => t >= minEdge && t <= duration - minEdge)
  const escolhidos = []
  for (let i = 1; i <= alvo; i++) {
    const ideal = i * espaco
    if (ideal > duration - minEdge) break
    const perto = uteis
      .filter((t) => !escolhidos.some((e) => Math.abs(e - t) < espaco))
      .sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0]
    if (perto == null || Math.abs(perto - ideal) > tolerancia) continue
    escolhidos.push(perto)
  }
  // a grade de 10s do projeto: o cue tem que cair em fronteira de segmento
  const grade = new Set(escolhidos.map((t) => Math.round(t / SEG) * SEG))
  return [...grade].filter((t) => t >= minEdge && t <= duration - minEdge).sort((a, b) => a - b)
}
