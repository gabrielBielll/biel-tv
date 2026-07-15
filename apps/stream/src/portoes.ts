// Portões 4 e 5 do cortador de comerciais (docs/features/cortador-comerciais.md).
//
// Os portões 1-3 (sinal, grade de duração, borda técnica) são aritmética e
// vivem no packages/pipeline/src/cortador.mjs. Estes dois são JULGAMENTO — as
// duas únicas perguntas da feature que não dá pra escrever em JS:
//   4. dois candidatos vizinhos são o MESMO comercial? (→ o limite entre eles
//      é fantasma: cortou no meio de um anúncio)
//   5. a transcrição é um anúncio INTEIRO ou morre no meio? (semântico)
//
// ⚠️ DUAS LIÇÕES DE TESTE CONTRA O GEMINI REAL (2026-07-14) — não desfazer sem
// reproduzir os testes:
//
// 1. NÃO PEÇA VEREDITO, PEÇA FATO. A primeira versão mostrava os dois frames
//    juntos e perguntava "são o mesmo anúncio?". Com frames de anúncios
//    claramente diferentes (uma cartela "KAISER" e uma "FUSCA 0KM"), o Gemini
//    respondeu "mesmo anúncio, confiança ALTA" e INVENTOU a justificativa:
//    "famosa promoção da Kaiser que sorteava Fuscas zero quilômetro". Não
//    existe. Mostrar dois frames lado a lado e pedir comparação convida o
//    modelo a achar coerência — e ele acha, com confiança alta, exatamente onde
//    o prompt mandava dizer "baixa". Descrevendo cada frame ISOLADO ele acertou
//    na hora: {"marca":"Kaiser","produto":"Cerveja","texto_na_tela":"KAISER"}.
//    É a regra da casa (diretor.ts:2): o LLM DECIDE (extrai fatos tipados), o
//    CÓDIGO CALCULA (compara as marcas). Aqui isso não é estilo — é o que
//    separa funcionar de alucinar.
//
// 2. INDISPONÍVEL ≠ REPROVADO. Medido na chave real: 503 ("high demand") depois
//    de 32s, 429 ("exceeded your quota") na chamada seguinte, 200 em 3.5s
//    depois de 20s de pausa. A chave é free tier. Se falta de cota reprovasse,
//    um compilado de 8 limites seria descartado quase inteiro POR COTA, não por
//    qualidade — e o Gabriel veria "não funciona" sem nunca saber por quê. Por
//    isso `Veredito.indisponivel` existe e é diferente de `ok: false`: quem
//    chama faz retry, e no fim se ABSTÉM (os portões 1-3 já são o grosso da
//    proteção — um limite fantasma teria que ter preto ∩ silêncio dos dois
//    lados E cair exatamente na grade de 15/30/60s pra chegar aqui).
import { pedeJson, pedeJsonComImagem } from './llm'

type Env = {
  GEMINI_API_KEY?: string
  DEEPSEEK_API_KEY?: string
}

export type Veredito = {
  ok: boolean
  motivo: string
  provedor?: string
  /** true = não deu pra perguntar (cota/erro/timeout). NÃO é reprovação:
   *  quem chama decide entre retry e abstenção. */
  indisponivel?: boolean
}

// ── portão 4: visual ───────────────────────────────────────────────────────

export type FrameDescrito = {
  marca: string
  produto: string
  cores: string
  texto_na_tela: string
}

const SCHEMA_FRAME = {
  type: 'object',
  properties: {
    marca: { type: 'string', description: 'a marca/anunciante visível, ou "" se não der pra dizer' },
    produto: { type: 'string', description: 'o que está sendo anunciado, ou ""' },
    cores: { type: 'string', description: 'as 2 cores dominantes' },
    texto_na_tela: { type: 'string', description: 'o texto legível no frame, ou ""' },
  },
  required: ['marca', 'produto', 'cores', 'texto_na_tela'],
}

/**
 * Cataloga UM frame — sem saber que existe outro, sem comparar, sem opinar.
 * O isolamento é o ponto (ver lição 1 no topo): é o que impede o modelo de
 * inventar uma narrativa que ligue duas imagens.
 */
export async function descreveFrame(env: Env, frameB64: string): Promise<FrameDescrito | null> {
  const system =
    'Você cataloga frames de comerciais de TV antigos. Descreva APENAS o que está ' +
    'visível NESTE frame. Não especule sobre campanhas, promoções ou contexto que ' +
    'você não veja na imagem. Se um campo não for legível no frame, devolva string vazia.'
  const out = await pedeJsonComImagem(env, system, 'Descreva este frame.', [frameB64], SCHEMA_FRAME)
  return out ? (out.json as FrameDescrito) : null
}

const norm = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * ⭐ O portão visual em si — e repare que é CÓDIGO, não LLM.
 *
 * O LLM só disse o que via em cada frame; a comparação é determinística,
 * reprodutível e auditável. Sem revisor humano, é isso que permite ao Gabriel
 * abrir o log meses depois e entender por que um comercial foi descartado — em
 * vez de interrogar um oráculo que já esqueceu.
 *
 * Dois vizinhos com a mesma marca = o limite entre eles é fantasma = os DOIS
 * morrem. Não tentamos "salvar" fundindo: descartar é grátis (tem compilado
 * infinito no YouTube), ingerir peça quebrada não.
 */
export function comparaVizinhos(a: FrameDescrito, b: FrameDescrito): Veredito {
  const ma = norm(a.marca)
  const mb = norm(b.marca)
  if (!ma || !mb) {
    // marca ilegível de um dos lados: este portão não tem o que dizer. Se
    // abstém em vez de chutar — os outros quatro já opinaram.
    return { ok: true, motivo: 'marca não legível nos frames — portão visual se absteve' }
  }
  if (ma === mb || ma.includes(mb) || mb.includes(ma)) {
    return { ok: false, motivo: `limite fantasma: os dois lados anunciam "${a.marca}" — é um comercial só, cortado no meio` }
  }
  return { ok: true, motivo: `"${a.marca}" → "${b.marca}"` }
}

/** Conveniência: descreve os dois e compara. `indisponivel` quando o Gemini
 *  não respondeu (cota/503) — quem chama faz retry e depois se abstém. */
export async function portaoVisual(env: Env, frameA: string, frameB: string): Promise<Veredito> {
  const [a, b] = await Promise.all([descreveFrame(env, frameA), descreveFrame(env, frameB)])
  // Sem Gemini não há fallback: o deepseek-v4-flash não aceita imagem (decisão
  // do Gabriel, 2026-07-14). Mas isso é INDISPONIBILIDADE, não reprovação.
  if (!a || !b) {
    return { ok: true, indisponivel: true, motivo: 'portão visual indisponível (Gemini fora/cota)' }
  }
  return { ...comparaVizinhos(a, b), provedor: 'gemini-3.5-flash' }
}

// ── portão 5: semântico ────────────────────────────────────────────────────

const SCHEMA_SEMANTICO = {
  type: 'object',
  properties: {
    completo: { type: 'boolean' },
    tem_fecho: { type: 'boolean' },
    marca: { type: 'string' },
    explicacao: { type: 'string' },
  },
  required: ['completo', 'tem_fecho', 'explicacao'],
}

/**
 * Portão 5 — de graça em cima do whisper que a fase 12 já roda.
 *
 * Um anúncio inteiro FECHA: slogan, marca, assinatura ("vá até uma revenda").
 * Cortado no meio, a transcrição morre no meio de uma frase. Classificação
 * binária de texto curto: o `deepseek-v4-flash` dá conta e já é pago (o
 * pedeJson tenta Gemini e cai pra ele sozinho — este portão, ao contrário do
 * visual, TEM fallback).
 */
export async function portaoSemantico(env: Env, transcricao: string): Promise<Veredito> {
  // Comercial pode ser mudo (só música e imagem) — e aí o whisper devolve quase
  // nada. Sem texto não há o que julgar: abstém em vez de reprovar.
  if (transcricao.trim().length < 12) {
    return { ok: true, motivo: 'sem transcrição suficiente (comercial mudo?) — portão semântico se absteve' }
  }

  const system =
    'Você audita cortes automáticos de comerciais de TV antigos. Recebe a transcrição ' +
    'de UM trecho recortado de um compilado. Diga se é um comercial COMPLETO ou um pedaço. ' +
    'Um comercial completo fecha: assinatura da marca, slogan, chamada final ' +
    '("vá até uma revenda", "ligue já", "nas melhores lojas"). Um trecho cortado no meio ' +
    'começa ou termina no meio de uma frase, sem fecho. Na dúvida, responda completo=false: ' +
    'é melhor descartar um comercial bom do que colocar um pela metade no ar.'
  const user = `Transcrição do trecho:\n\n"""${transcricao.slice(0, 4000)}"""`

  const out = await pedeJson(env, system, user, SCHEMA_SEMANTICO)
  if (!out) return { ok: true, indisponivel: true, motivo: 'portão semântico indisponível (Gemini e DeepSeek fora)' }

  const { completo, tem_fecho, marca, explicacao } = out.json
  if (!completo) return { ok: false, motivo: `trecho incompleto: ${explicacao}`, provedor: out.provedor }
  return {
    ok: true,
    motivo: `${marca ? `${marca}: ` : ''}${explicacao}${tem_fecho ? ' (tem fecho)' : ''}`,
    provedor: out.provedor,
  }
}

// ── nomeação das peças ─────────────────────────────────────────────────────

export type Acervo = { canais: string[]; programas: string[] }

/**
 * O acervo do Gabriel (2026-07-15). Vocabulário FECHADO pra corrigir o que o
 * whisper erra em nome próprio de época.
 *
 * ⚠️ TODO: derivar do D1 (as séries do catálogo) em vez de hardcode — assim
 * cresce sozinho quando ele sobe um desenho novo. Hardcoded por ora porque a
 * primeira leva de recorte precisa disto antes da fábrica existir.
 */
export const ACERVO: Acervo = {
  canais: ['Jetix', 'Cartoon Network', 'Disney Channel'],
  programas: [
    'Os Padrinhos Mágicos', 'Yin Yang Yo!', 'Power Rangers: Galáxia Perdida',
    'Power Rangers: O Resgate', 'Pucca', 'Beyblade',
    'Madagascar: Perseguidos por um Cupcake Gigante',
    'Super Esquadrão dos Macacos Robôs Hiperforça Já!',
    'O Show dos Looney Tunes', 'A Vida e Aventuras de Juniper Lee',
    'Martin Mystery', 'Hey Arnold!', 'Danny Phantom',
    'Jake Long: O Dragão Ocidental',
  ],
}

/**
 * A FUNÇÃO da peça — o que distingue várias peças do MESMO programa.
 *
 * Veio do roteiro que o Gabriel usa pras vinhetas geradas (2026-07-15): cada
 * programa tem 3 peças fixas, e o problema dele era justamente "tem vários
 * comerciais do mesmo desenho, é bom dar detalhes pra saber o que é". Três
 * peças de Pucca não são 3 nomes iguais: são Pucca-início, Pucca-saída,
 * Pucca-volta.
 *
 * As frases de época já falam assim, então o mesmo classificador serve pro
 * acervo recortado E pras vinhetas que o construtor vai gerar. E casa direto
 * com os tipos de promessa da fase 12.
 */
export type FuncaoPeca = 'inicio' | 'saida' | 'volta' | 'anuncio' | 'outro'

/** função da peça → tipo de promessa da fase 12 (o agendador já sabe cumprir) */
export const FUNCAO_TO_PROMESSA: Record<string, string | null> = {
  inicio: 'a_seguir', // "A seguir: X" / "E agora: X"
  volta: 'durante', // "Você está assistindo X" — bumper de permanência
  saida: 'durante', // "Voltamos já com X" — segura pro intervalo
  anuncio: null,
  outro: null,
}

const SCHEMA_NOME = {
  type: 'object',
  properties: {
    programa: { type: 'string' },
    funcao: { type: 'string', enum: ['inicio', 'saida', 'volta', 'anuncio', 'outro'] },
    fora_do_acervo: { type: 'boolean' },
    detalhe: { type: 'string' },
    completa: { type: 'boolean' },
  },
  required: ['programa', 'funcao', 'fora_do_acervo', 'detalhe', 'completa'],
}

const slug = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)

/**
 * Nomeia uma peça recortada. Pedido do Gabriel: *"é bom dar nomes certos pra
 * esses comerciais partidos para ficar mais fácil de identificar"*.
 *
 * ⚠️ Sem o vocabulário, o LLM HERDA o erro do whisper e batiza o arquivo errado
 * PRA SEMPRE — e nome errado é pior que nome genérico, porque parece confiável.
 * Medido no acervo real: "Chamada Sinascópio Yohasa" (whisper errando
 * "Cinescópio" e "Yoh Asakura"), "Mega Man Anity 2000X". Com o vocabulário:
 * "Shaman King", "Mega Man", "Cinescópio".
 *
 * ⚠️ E a regra do NÃO-FORÇAR é o que faz isto ser seguro: os compilados são
 * intervalos de época INTEIROS e a maior parte do que passa neles não está no
 * acervo (Cinescópio, Mega Man, os filmes — 7 de 8 peças medidas). Obrigar o
 * encaixe na lista faria "Mega Man" virar "Beyblade" (o mais próximo) — um erro
 * confiante, que é o pior tipo. A lista corrige o que conhece; o resto sai como
 * o modelo entender, marcado `fora_do_acervo`.
 */
export async function nomeiaPeca(
  env: Env,
  transcricao: string,
  durSeg: number,
  canal: string,
  acervo: Acervo = ACERVO,
): Promise<{ id: string; nome: string; programa: string; funcao: FuncaoPeca; promessa: string | null; foraDoAcervo: boolean; completa: boolean } | null> {
  if (transcricao.trim().length < 8) return null // peça muda: o nome sai da imagem, não daqui

  const system =
    'Você cataloga peças de intervalo de TV brasileira dos anos 2000 (canais retrô). ' +
    'Recebe a transcrição de UMA peça.\n' +
    'A transcrição é AUTOMÁTICA e erra nomes próprios (ex.: escreve "Sinascópio" onde se diz "Cinescópio").\n' +
    `PROGRAMAS do acervo: ${acervo.programas.join(' | ')}\n` +
    'REGRA: se a peça se referir a um programa da lista (mesmo mal transcrito), use a GRAFIA EXATA da lista.\n' +
    'Se NÃO estiver na lista, NÃO force nada dela — use o nome que você entender e marque fora_do_acervo=true.\n' +
    'FUNÇÃO da peça (é o que distingue várias peças do MESMO programa):\n' +
    ' "inicio" = anuncia o que vem ("A seguir:", "E agora:")\n' +
    ' "saida"  = segura pro intervalo ("Voltamos já com", "Não saia daí")\n' +
    ' "volta"  = identifica o que está no ar ("Você está assistindo", "Continuem vendo")\n' +
    ' "anuncio" = publicidade de produto/terceiro · "outro" = nada disso\n' +
    'NÃO opine sobre o canal: ele já é conhecido.\n' +
    'Responda em json com as chaves: programa (string), funcao ("inicio"|"saida"|"volta"|"anuncio"|"outro"), ' +
    'fora_do_acervo (boolean), detalhe (string, max 5 palavras que distingam esta peça de outra do mesmo programa), ' +
    'completa (boolean).'
  const user = `Peça de ${durSeg.toFixed(0)}s do canal ${canal}. Transcrição:\n"""${transcricao.slice(0, 1500)}"""\nResponda em json.`

  const out = await pedeJson(env, system, user, SCHEMA_NOME)
  if (!out) return null
  const j = out.json

  const programa = String(j.programa ?? '').trim()
  const funcao = (['inicio', 'saida', 'volta', 'anuncio', 'outro'].includes(j.funcao) ? j.funcao : 'outro') as FuncaoPeca
  const detalhe = String(j.detalhe ?? '').trim()

  // ⚠️ O NOME é montado pelo CÓDIGO, com o canal que o CHAMADOR já sabe.
  // Pedir o canal ao LLM foi um erro medido: ele devolveu "Cartoon Network" pra
  // uma peça do Beyblade num compilado do JETIX — inventou um fato que o código
  // tinha na mão (está no media_item de origem). Regra da casa (diretor.ts:2):
  // o LLM DECIDE (extrai o que só se sabe lendo), o CÓDIGO CALCULA (o resto).
  const partes = [canal, programa || null, funcao !== 'outro' && funcao !== 'anuncio' ? funcao : null, detalhe || null]
  const nome = partes.filter(Boolean).join(' · ')

  return {
    // id determinístico e LEGÍVEL — o Gabriel pede pra poder editar depois
    id: ['com', slug(canal), slug(programa || detalhe || 'peca'), funcao].filter(Boolean).join('_'),
    nome,
    programa,
    funcao,
    promessa: FUNCAO_TO_PROMESSA[funcao] ?? null,
    foraDoAcervo: Boolean(j.fora_do_acervo),
    completa: Boolean(j.completa),
  }
}
