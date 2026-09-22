// Tira do ar os comerciais que saíram com a cama musical errada e manda a
// fábrica refazê-los.
//
// Queixas do Gabriel no ar (21/09/2026): "kid vs kat só passa um comercial com
// uma imagem fixa e de fundo a música do power rangers força animal", "pr fúria
// da selva entrando com a música do força animal", "operação ultraveloz também",
// "pucca também".
//
// Causa: só um molde tem trilha embutida — `md_cc2e221477` "Jetix — Power
// Rangers teste", com `cama_power_rangers.m4a`. Ele virou o padrão do canal por
// ser o mais recente, e 19 peças saíram com ele. O commit eb537ee (18/09)
// consertou a ESCOLHA (agora prefere molde sem cama), mas as 19 já montadas
// nunca foram refeitas — a mensagem daquele commit diz "falta refazer os 12; a
// cota de escrita do D1 está estourada até as 21h". Ficaram no ar desde então.
//
// E eb537ee errou numa premissa: tratou as 7 de Power Rangers como corretas.
// Não são — a cama é de UMA temporada (Força Animal) tocando em todas, e a
// regra da casa proíbe promo de outra temporada do mesmo desenho.
//
// O molde NÃO é apagado: `DELETE /moldes/:id` apagaria o PNG e a música do R2,
// e a cama ainda serve pro bloco Geração Power Rangers. É só renomeado para
// deixar de parecer molde de uso geral.
//
// ⚠️ CUSTO DE ESCRITA — e esta é a lição cara de 22/09/2026: a primeira versão
//    deste script desativava peça por peça pelo `/media/:id/status`, e AQUELE
//    endpoint replanejava o canal a cada chamada. As 19 peças são todas do
//    jetix, então saíram 19 replans do mesmo canal em fila: 397 MIL linhas numa
//    hora, quatro vezes o teto diário do D1 free tier. A fábrica morreu e 33
//    episódios ficaram o dia inteiro parados.
//    Agora usa `POST /admin/media/status` (lote), que replaneja cada canal UMA
//    vez — mesmo padrão do `aplicaCanais`. Custo: ~13 mil linhas em vez de 397
//    mil.
//
// Uso:  node scripts/conserta-comerciais-cama.mjs            (dry-run)
//       node scripts/conserta-comerciais-cama.mjs --aplicar
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID
const TOKEN = process.env.CLOUDFLARE_API_TOKEN
const ADMIN = process.env.ADMIN_TOKEN
const DB = process.env.D1_DATABASE_ID ?? 'c7790950-7ee9-4169-8d0c-40e7ce8672d9'
const BASE = process.env.BASE ?? 'https://biel-tv-stream.biel-cesa95.workers.dev'
const MOLDE_COM_CAMA = 'md_cc2e221477'
const APLICAR = process.argv.includes('--aplicar')
if (!ACCOUNT || !TOKEN) { console.error('faltam credenciais: set -a; . ~/bieltv-cred.env; set +a'); process.exit(2) }

async function d1(sql, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  })
  const j = await r.json()
  if (!j.success) throw new Error(JSON.stringify(j.errors))
  return j.result[0].results
}
const admin = (path, body, method = 'POST') => fetch(`${BASE}/admin${path}`, {
  method, headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
})

const molde = (await d1('SELECT id, nome, musica_key FROM moldes WHERE id = ?1', [MOLDE_COM_CAMA]))[0]
const pecas = await d1(
  `SELECT j.series_id, j.media_id, m.status
     FROM commercial_build_jobs j JOIN media_items m ON m.id = j.media_id
    WHERE j.molde_id = ?1 AND m.status = ?2 ORDER BY j.series_id`,
  [MOLDE_COM_CAMA, 'ready'],
)
const NOVO_NOME = 'Jetix — Power Rangers (CAMA PRÓPRIA · só para o bloco Geração PR)'
console.log(`molde: ${molde?.nome ?? '(não existe)'}`)
console.log(`  cama: ${molde?.musica_key ?? '—'}`)
console.log(`  renomear para: "${NOVO_NOME}"\n`)
console.log(`COMERCIAIS NO AR COM ESSA CAMA: ${pecas.length}`)
for (const p of pecas) console.log(`  ${p.series_id.padEnd(32)} ${p.media_id}`)
console.log('\nO que o --aplicar faz:')
console.log('  1. renomeia o molde (não apaga: a cama serve pro bloco Geração PR)')
console.log(`  2. desativa as ${pecas.length} peças (saem do ar, recuperáveis por status=ready)`)
console.log('  3. reconcilia a grade → a fábrica refaz cada uma com molde sem cama')
console.log('     e com a voz do canal unificada (fix 2eb16e3)')
if (!APLICAR) { console.log('\n(dry-run — rode com --aplicar para gravar)'); process.exit(0) }
if (!ADMIN) { console.error('\nfalta ADMIN_TOKEN'); process.exit(2) }

// 1. renomear — não há endpoint de edição de molde, então é UPDATE direto
await d1('UPDATE moldes SET nome = ?2 WHERE id = ?1', [MOLDE_COM_CAMA, NOVO_NOME])
console.log('✔ 1/3 molde renomeado')

// 2. desativar EM LOTE — um replan por canal, não um por peça
const res2 = await admin('/media/status', { ids: pecas.map((p) => p.media_id), status: 'disabled' })
const body2 = await res2.json().catch(() => ({}))
if (!res2.ok) {
  console.error(`✖ 2/3 desativar HTTP ${res2.status}`, JSON.stringify(body2).slice(0, 200))
  console.error('parou: não reconcilio com peça pendurada')
  process.exit(1)
}
console.log(`✔ 2/3 desativadas: ${body2.mudados} | canais replanejados: ${(body2.canais_replanejados ?? []).join(', ') || '—'}`)

// 3. reconciliar → gera as novas
const rec = await admin('/fabrica-comerciais/reconciliar-grade', {})
const body = await rec.json().catch(() => ({}))
if (!rec.ok) { console.error(`✖ 3/3 reconciliar HTTP ${rec.status}`, JSON.stringify(body).slice(0, 200)); process.exit(1) }
console.log(`✔ 3/3 reconciliado — gerados: ${(body.gerados ?? []).length} | recolhidos: ${(body.recolhidos ?? []).length}`)
console.log('\nA fábrica monta as novas na próxima rodada. Acompanhe na aba Fábrica.')
