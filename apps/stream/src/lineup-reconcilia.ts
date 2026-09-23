// RECONCILIADOR DE LINEUPS: mantém a fábrica acompanhando a grade sozinha.
// Pedido do Gabriel (23/09/2026): "se ela detectar que a grade mudou ela vai
// atualizar".
//
// A cada rodada (cron diário, depois de mexer nas âncoras, botão/rota manual):
//   1. conta, na grade exibida (7 dias) + planejada (48 h), as sequências X→Y→Z
//      em que o lineup teria onde entrar (intervalo dentro do bloco de X);
//   2. quer peça pra toda sequência que se REPETE (≥ 2 ocorrências) e que
//      ainda está na grade (≥ 1 no futuro). Sequência que aparece uma vez só
//      não vale a locução;
//   3. o que não tem peça nem job na fila vira job `lineup_sequencia`. A fábrica
//      (Actions ou o celular) sintetiza a locução, monta, publica, e o /done
//      grava a promessa com a sequência.
//
// Quem SOME da grade não precisa de nada: o scheduler só encaixa lineup onde a
// sequência é verdade, então a peça antiga simplesmente para de tocar.
//
// Liga com DUAS chaves no `config`: `lineup_grade:<canal>` (o encaixe) e
// `lineup_reconciliador` = '1' (esta automação). A segunda existe pra dar pra
// publicar o Worker antes de a fábrica do Actions saber montar este job.
import { dispatchFabrica } from './fabrica'
import {
  PREFIXO_LINEUP, inventarioSequencias, posicaoDoConfig, sequenciaDaCondicao,
  type InfoMidia, type LinhaGrade, type Sequencia,
} from './lineup-grade'

type Env = { DB: D1Database; GH_DISPATCH_TOKEN?: string; GH_REPO?: string }

/** Igual a VERSAO_LINEUP de packages/pipeline/src/lineup-texto.mjs — entra no media_id. */
export const VERSAO_LINEUP = 'lote-local-2026-09-23-v1'

/** media_id da peça: sha1(canal|X>Y>Z|versão). O lote local calcula igual (idLineup). */
export async function idLineup(canal: string, seq: Sequencia, versao = VERSAO_LINEUP): Promise<string> {
  const h = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${canal}|${seq.join('>')}|${versao}`))
  return `${PREFIXO_LINEUP}${[...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)}`
}

// Teto de jobs novos por rodada: cada um gasta uma locução no ElevenLabs e
// entra na mesma fila dos episódios. As rodadas seguintes completam o resto.
const MAX_POR_RODADA = 12
const HISTORICO = 7 * 86400

export interface ReconLineups {
  em: number
  ativo: boolean
  seco?: boolean
  motivo?: string
  canais: Record<string, { sequencias: number; com_peca: number; na_fila: number; faltando: number }>
  enfileirados: Array<{ canal: string; seq: Sequencia; media_id: string }>
  /** seco ou automação desligada: o que SERIA enfileirado */
  seriam: Array<{ canal: string; seq: Sequencia; media_id: string }>
  erros: Array<{ job: string; seq: string; erro: string | null }>
}

export async function reconciliaLineups(env: Env, { seco = false }: { seco?: boolean } = {}): Promise<ReconLineups> {
  const agora = Math.floor(Date.now() / 1000)
  const rel: ReconLineups = { em: agora, ativo: false, ...(seco ? { seco } : {}), canais: {}, enfileirados: [], seriam: [], erros: [] }

  const { results: cfg } = await env.DB.prepare(
    "SELECT k, v FROM config WHERE k LIKE 'lineup_grade:%' OR k = 'lineup_reconciliador'",
  ).all<{ k: string; v: string }>()
  const canais = cfg.filter((c) => c.k.startsWith('lineup_grade:') && posicaoDoConfig(c.v)).map((c) => c.k.slice(13))
  rel.ativo = cfg.some((c) => c.k === 'lineup_reconciliador' && c.v === '1')
  if (canais.length === 0) { rel.motivo = 'nenhum canal com lineup_grade ligado'; return rel }

  // peças que já existem (promessa confirmada com a sequência)
  const cobertas = new Set<string>()
  const { results: proms } = await env.DB.prepare(
    "SELECT media_id, condicao FROM media_promises WHERE status = 'confirmada' AND condicao LIKE '%lineup_grade%'",
  ).all<{ media_id: string; condicao: string }>()
  for (const p of proms) {
    try {
      const cond = JSON.parse(p.condicao) as Record<string, unknown>
      const seq = cond.tipo === 'lineup_grade' ? sequenciaDaCondicao(cond) : null
      if (seq && typeof cond.canal === 'string') cobertas.add(`${cond.canal}|${seq.join('>')}`)
    } catch { /* condição corrompida: não cobre nada */ }
  }

  // jobs deste reconciliador ainda vivos. `job_type`/`request_payload` são da
  // migration 0035: sem ela, não há como enfileirar — relata e sai.
  const naFila = new Set<string>()
  try {
    const { results: jobs } = await env.DB.prepare(
      "SELECT id, status, error, request_payload FROM commercial_build_jobs WHERE job_type = 'lineup_sequencia'",
    ).all<{ id: string; status: string; error: string | null; request_payload: string | null }>()
    for (const j of jobs) {
      let req: { canal?: string; seq?: string[] } = {}
      try { req = JSON.parse(j.request_payload ?? '{}') } catch { /* payload corrompido */ }
      const k = `${req.canal}|${(req.seq ?? []).join('>')}`
      // em erro também segura: refazer sozinho em laço queimaria locução.
      // O relatório mostra, e o retry é manual (POST /:id/retry).
      naFila.add(k)
      if (j.status === 'error') rel.erros.push({ job: j.id, seq: k, erro: j.error })
    }
  } catch {
    rel.motivo = 'migration 0035 ainda não aplicada (commercial_build_jobs sem job_type)'
    return rel
  }

  // molde do canal: a coluna é NOT NULL, mas o lineup não usa (o visual vem do
  // lineup.config.json do repositório). Prefere o sem cama, como os comerciais.
  const { results: moldes } = await env.DB.prepare(
    'SELECT id, canal, musica_key FROM moldes ORDER BY created_at DESC',
  ).all<{ id: string; canal: string; musica_key: string | null }>()
  const moldeDe = new Map<string, string>()
  for (const m of moldes.filter((x) => !x.musica_key).concat(moldes.filter((x) => x.musica_key))) {
    if (!moldeDe.has(m.canal)) moldeDe.set(m.canal, m.id)
  }

  const novos: Array<{ canal: string; seq: Sequencia; peso: number }> = []
  for (const canal of canais) {
    const { results: grade } = await env.DB.prepare(
      `SELECT e.media_id, e.start_time_virtual s, e.end_time_virtual f, m.tipo, json_extract(m.metadata, '$.series_id') sid
       FROM epg_virtual e LEFT JOIN media_items m ON m.id = e.media_id
       WHERE e.canal = ?1 AND e.start_time_virtual >= ?2 ORDER BY e.start_time_virtual`,
    ).bind(canal, agora - HISTORICO).all<{ media_id: string; s: number; f: number; tipo: string | null; sid: string | null }>()
    const info = new Map<string, InfoMidia>(grade.map((r) => [r.media_id, { tipo: r.tipo, series_id: r.sid }]))
    const inv = inventarioSequencias(grade.map((r): LinhaGrade => [canal, r.media_id, r.s, r.f, 0]), info, agora)
    const querida = [...inv.values()].filter((x) => x.futuras >= 1 && x.encaixaveis >= 2)
    let comPeca = 0
    let fila = 0
    for (const x of querida) {
      const k = `${canal}|${x.seq.join('>')}`
      if (cobertas.has(k)) comPeca++
      else if (naFila.has(k)) fila++
      else novos.push({ canal, seq: x.seq, peso: x.encaixaveis })
    }
    rel.canais[canal] = { sequencias: querida.length, com_peca: comPeca, na_fila: fila, faltando: querida.length - comPeca - fila }
  }

  // as que mais aparecem primeiro: é onde a peça rende mais exibição
  novos.sort((a, b) => b.peso - a.peso)
  for (const n of novos.slice(0, MAX_POR_RODADA)) {
    const mediaId = await idLineup(n.canal, n.seq)
    if (seco || !rel.ativo) { rel.seriam.push({ canal: n.canal, seq: n.seq, media_id: mediaId }); continue }
    const molde = moldeDe.get(n.canal)
    if (!molde) continue
    rel.enfileirados.push({ canal: n.canal, seq: n.seq, media_id: mediaId })
    // id do job derivado da peça: duas rodadas concorrentes não duplicam
    await env.DB.prepare(
      `INSERT OR IGNORE INTO commercial_build_jobs
         (id, media_id, title, molde_id, series_id, slot_dias, slot_hora, job_type, request_payload, publish)
       VALUES (?1, ?2, ?3, ?4, ?5, '[]', '00:00', 'lineup_sequencia', ?6, 1)`,
    ).bind(
      `cb_${mediaId.slice(PREFIXO_LINEUP.length, PREFIXO_LINEUP.length + 10)}`, mediaId,
      `Lineup: ${n.seq.join(' → ')}`, molde, n.seq[0],
      JSON.stringify({ canal: n.canal, seq: n.seq, versao: VERSAO_LINEUP }),
    ).run()
  }
  if (!rel.ativo) rel.motivo = "automação desligada (config lineup_reconciliador ≠ '1'): só inventário"
  if (!seco && rel.ativo && rel.enfileirados.length > 0) await dispatchFabrica(env)
  if (!seco) {
    try {
      await env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('reconcilia_lineups', ?1)")
        .bind(JSON.stringify(rel)).run()
    } catch { /* relatório é best-effort */ }
  }
  return rel
}
