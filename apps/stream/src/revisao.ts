// Bancada de revisão das peças recortadas — ideia do Gabriel (2026-07-15):
// "crie uma nova rota e coloque esses vídeos dos comerciais cortados, assim eu
//  posso ver e dar o clique pra ver certinho onde ele termina e analisar; aí ela
//  pode ser a janela de onde você trabalha e eu posso ver".
//
// O problema que ela resolve: revisar 24 peças esperando passarem no rodízio é
// inviável — ele não controla a ordem nem sabe quando vem. Aqui elas ficam
// enfileiradas, com um clique pro INÍCIO e outro pro FIM, que é exatamente onde
// mora o defeito quando o corte erra (peça que nasce com preto na cara, ou que
// termina no meio da locução).
//
// Por que playlist NOVA e não a do canal: o /live/:canal é um fluxo contínuo e
// infinito (janela deslizante em torno do relógio), desenhado pra manter todos
// os espectadores sincronizados. Pra inspecionar UMA peça é preciso um VOD, com
// início, fim e seek — coisas que o live não tem por construção.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { MARCADOR } from './marcador'

type Bindings = { DB: D1Database; ADMIN_TOKEN?: string }

export const revisao = new Hono<{ Bindings: Bindings }>()
revisao.use('*', cors())

/** As categorias do veredito. Cada uma aponta pra uma parte ESPECÍFICA do motor
 *  — é isso que torna a nota acionável (ver 0016_revisao_notas.sql). */
const CATEGORIAS = ['corte_no_meio', 'pedaco_vizinho', 'nao_e_peca', 'nome_errado', 'preto_demais', 'outro']

const SEG = 10 // s por segmento — a regra de ouro do pipeline
const pad5 = (n: number) => String(n).padStart(5, '0')

/** As peças, mais novas primeiro. Público e read-only: o /media/* já é aberto
 *  (é o que o player do canal consome), então listar não expõe nada novo. */
revisao.get('/lista', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.status, m.duracao_seg, m.segment_count, m.created_at,
            COALESCE(json_extract(m.metadata,'$.title'), json_extract(m.metadata,'$.titulo'), m.id) AS titulo,
            mc.channel_id AS canal,
            n.veredito, n.categoria, n.motivo
     FROM media_items m
     LEFT JOIN media_channels mc ON mc.media_id = m.id
     LEFT JOIN revisao_notas n ON n.media_id = m.id
     WHERE m.tipo = 'comercial'
     ORDER BY m.created_at DESC, m.id`,
  ).all()
  return c.json(results)
})

/**
 * O veredito do Gabriel sobre uma peça — o gabarito, gerado enquanto ele revisa.
 *
 * Escreve, então exige o token (o resto da bancada é público e read-only).
 * `ruim` também tira do ar na mesma tacada: ele já estava fazendo os dois passos
 * na mão, e separá-los só criaria peça marcada como ruim que continua no ar.
 */
revisao.post('/:id/nota', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  if (!c.env.ADMIN_TOKEN || token !== c.env.ADMIN_TOKEN) return c.json({ error: 'não autorizado' }, 401)

  const b = await c.req.json<{ veredito?: string; categoria?: string; motivo?: string }>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const veredito = b.veredito === 'boa' ? 'boa' : b.veredito === 'ruim' ? 'ruim' : null
  if (!veredito) return c.json({ error: "veredito tem que ser 'boa' ou 'ruim'" }, 400)
  const categoria = veredito === 'ruim' && CATEGORIAS.includes(b.categoria ?? '') ? b.categoria! : null
  const motivo = String(b.motivo ?? '').slice(0, 500)

  const id = c.req.param('id')
  const existe = await c.env.DB.prepare('SELECT id FROM media_items WHERE id = ?1').bind(id).first()
  if (!existe) return c.json({ error: 'peça não existe' }, 404)

  await c.env.DB.prepare(
    `INSERT INTO revisao_notas (media_id, veredito, categoria, motivo)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(media_id) DO UPDATE SET
       veredito = ?2, categoria = ?3, motivo = ?4, updated_at = unixepoch()`,
  ).bind(id, veredito, categoria, motivo).run()

  // ruim ⇒ fora do ar; boa ⇒ garante no ar (ele pode ter tirado e se arrependido)
  await c.env.DB.prepare('UPDATE media_items SET status = ?2 WHERE id = ?1')
    .bind(id, veredito === 'ruim' ? 'disabled' : 'ready').run()

  return c.json({ ok: true, veredito, categoria })
})

/** Os compilados que esperam marcação — os intervalos longos do acervo. */
revisao.get('/compilados', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.duracao_seg, m.status,
            COALESCE(json_extract(m.metadata,'$.title'), json_extract(m.metadata,'$.titulo'), m.id) AS titulo,
            cm.pecas, cm.status AS corte_status, cm.n_pecas
     FROM media_items m
     LEFT JOIN cortes_marcados cm ON cm.compilado_id = m.id
     WHERE m.tipo = 'comercial' AND m.duracao_seg >= 120
     ORDER BY m.duracao_seg DESC`,
  ).all()
  return c.json(results)
})

/**
 * As peças que o Gabriel marcou assistindo — {ini, fim, nome} cada uma.
 *
 * ⚠️ Isto é o gabarito, não uma sugestão: 6 sinais automáticos foram medidos
 * contra o que ele anotou à mão e o melhor (cena) acerta 5/6 mas dispara 138×.
 * Quem manda aqui é ele; o motor virou opinião opcional.
 *
 * O buraco entre uma peça e a seguinte é INTENCIONAL — é o lixo que ele mandou
 * descartar ("o resto é lixo só recortes"). Por isso peça tem fim próprio em vez
 * de terminar onde a próxima começa (ver 0017_cortes_pecas.sql).
 */
revisao.post('/:id/pecas', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  if (!c.env.ADMIN_TOKEN || token !== c.env.ADMIN_TOKEN) return c.json({ error: 'não autorizado' }, 401)
  const b = await c.req.json<{ pecas?: { ini?: number; fim?: number; nome?: string }[] }>().catch(() => null)
  if (!b || !Array.isArray(b.pecas)) return c.json({ error: 'pecas tem que ser um array de {ini, fim, nome}' }, 400)
  if (!b.pecas.length) return c.json({ error: 'marque pelo menos uma peça' }, 400)

  const id = c.req.param('id')
  const m = await c.env.DB.prepare('SELECT duracao_seg FROM media_items WHERE id = ?1')
    .bind(id).first<{ duracao_seg: number }>()
  if (!m) return c.json({ error: 'compilado não existe' }, 404)

  const pecas = b.pecas
    .map((p) => ({
      ini: Math.round(Number(p.ini) * 100) / 100,
      fim: Math.round(Number(p.fim) * 100) / 100,
      // nome vazio ⇒ null: é o contrato do PLANO (`pc.nome ?? fallback`) — quem
      // não foi nomeado por ele é nomeado pelo LLM, e '' não diz isso.
      nome: String(p.nome ?? '').trim().slice(0, 120) || null,
    }))
    .sort((x, y) => x.ini - y.ini)

  for (const [i, p] of pecas.entries()) {
    if (!Number.isFinite(p.ini) || !Number.isFinite(p.fim)) return c.json({ error: `peça ${i + 1}: ini/fim não é número` }, 400)
    if (p.ini < 0 || p.fim > m.duracao_seg + 0.5) return c.json({ error: `peça ${i + 1}: cai fora do compilado (0–${m.duracao_seg}s)` }, 400)
    // 0.5s: abaixo disso é escorregão de tecla, não peça — e o cortador gastaria
    // um ingest inteiro pra produzir lixo
    if (p.fim - p.ini < 0.5) return c.json({ error: `peça ${i + 1}: dura ${(p.fim - p.ini).toFixed(2)}s — fim tem que vir depois do início` }, 400)
    // encostar (fim == ini da próxima) é normal e comum: no acervo dele o
    // Batalhão termina exatamente onde o Medabots começa (473.0). Sobrepor não:
    // geraria o mesmo trecho em duas peças.
    if (i > 0 && p.ini < pecas[i - 1].fim - 0.01) return c.json({ error: `peça ${i + 1} sobrepõe a ${i}` }, 400)
  }

  await c.env.DB.prepare(
    `INSERT INTO cortes_marcados (compilado_id, pecas, status) VALUES (?1, ?2, 'marcado')
     ON CONFLICT(compilado_id) DO UPDATE SET pecas = ?2, status = 'marcado', updated_at = unixepoch()`,
  ).bind(id, JSON.stringify(pecas)).run()
  return c.json({ ok: true, pecas })
})

/** O placar, pra eu ler e saber ONDE o motor erra — não SE erra. */
revisao.get('/notas', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT n.media_id, n.veredito, n.categoria, n.motivo, m.duracao_seg,
            COALESCE(json_extract(m.metadata,'$.title'), m.id) AS titulo
     FROM revisao_notas n JOIN media_items m ON m.id = n.media_id
     ORDER BY n.updated_at DESC`,
  ).all()
  const porCat: Record<string, number> = {}
  for (const r of results as any[]) {
    const k = r.veredito === 'boa' ? 'boa' : (r.categoria ?? 'sem_categoria')
    porCat[k] = (porCat[k] ?? 0) + 1
  }
  return c.json({ total: results.length, porCategoria: porCat, notas: results })
})

/**
 * Playlist VOD de UMA peça. `#EXT-X-PLAYLIST-TYPE:VOD` + `#EXT-X-ENDLIST` é o
 * que diz ao hls.js "isto tem fim, pode dar seek" — sem eles ele trata como
 * live e a barra de progresso não funciona.
 *
 * A última duração é a real, não 10s: o pipeline pada a mídia pra múltiplo de
 * 10, mas a peça em si termina antes. Declarar 10 no último segmento faria o
 * player mostrar uma duração maior que a verdadeira, e o Gabriel está aqui
 * justamente pra conferir onde a peça TERMINA.
 */
revisao.get('/:id/playlist.m3u8', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare(
    'SELECT id, duracao_seg, segment_count, path_prefix, base_url FROM media_items WHERE id = ?1',
  ).bind(id).first<{ id: string; duracao_seg: number; segment_count: number; path_prefix: string; base_url: string }>()
  if (!row) return c.text('peça não encontrada\n', 404)

  const base = (row.base_url ?? '').replace(/\/+$/, '')
  const uri = (i: number) => {
    const f = `${row.path_prefix}/seg${pad5(i)}.ts`
    return base ? `${base}/${f}` : `/${f}` // base_url vazia = rota /media/* do Worker
  }

  const linhas = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG}`,
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
  for (let i = 0; i < row.segment_count; i++) {
    const resta = row.duracao_seg - i * SEG
    const dur = Math.min(SEG, Math.max(0.1, resta))
    linhas.push(`#EXTINF:${dur.toFixed(3)},`, uri(i))
  }
  linhas.push('#EXT-X-ENDLIST')
  return c.body(linhas.join('\n') + '\n', 200, {
    'content-type': 'application/vnd.apple.mpegurl',
    'cache-control': 'no-cache', // a peça pode ser reprocessada; não congelar
  })
})

// ── a página ───────────────────────────────────────────────────────────────
// Auto-contida de propósito: sem build, sem deploy de Pages, sem passo extra
// entre "consertei" e "o Gabriel vê". O hls.js vem de CDN (Chrome não toca HLS
// nativo; Safari toca).
const PAGINA = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bancada — peças recortadas</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<style>
  :root{--bg:#0d0f14;--card:#161a22;--line:#232936;--txt:#e6e9ef;--dim:#8b94a7;--ac:#4ea1ff;--ok:#3ecf8e;--no:#ff5c5c}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
  header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:center;flex-wrap:wrap;position:sticky;top:0;background:var(--bg);z-index:5}
  h1{font-size:15px;margin:0;font-weight:600}
  .cont{font-size:12px;color:var(--dim)}
  .wrap{display:grid;grid-template-columns:minmax(280px,380px) 1fr;gap:0;height:calc(100vh - 53px)}
  @media(max-width:820px){.wrap{grid-template-columns:1fr;height:auto}}
  .lista{overflow-y:auto;border-right:1px solid var(--line)}
  .it{padding:10px 14px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;gap:10px;align-items:baseline}
  .it:hover{background:var(--card)}
  .it.sel{background:#1b2333;box-shadow:inset 3px 0 0 var(--ac)}
  .it.off{opacity:.4}
  .dur{font-variant-numeric:tabular-nums;color:var(--dim);font-size:12px;min-width:44px}
  .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .id{font-size:11px;color:var(--dim);font-family:ui-monospace,monospace}
  .palco{padding:18px;overflow-y:auto}
  video{width:100%;max-width:640px;background:#000;border-radius:8px;display:block}
  .btns{display:flex;gap:8px;margin:12px 0;flex-wrap:wrap}
  button{background:var(--card);color:var(--txt);border:1px solid var(--line);padding:7px 13px;border-radius:6px;cursor:pointer;font-size:13px}
  button:hover{border-color:var(--ac)}
  button.pri{background:var(--ac);border-color:var(--ac);color:#07101d;font-weight:600}
  button.dang{border-color:var(--no);color:var(--no)}
  .meta{color:var(--dim);font-size:12px;margin-top:10px;line-height:1.7}
  .meta b{color:var(--txt);font-weight:500}
  .vazio{color:var(--dim);padding:40px 18px;text-align:center}
  input{background:var(--card);border:1px solid var(--line);color:var(--txt);padding:6px 9px;border-radius:6px;font-size:12px;width:200px}
  .tag{font-size:10px;padding:1px 6px;border-radius:4px;background:#232936;color:var(--dim)}
  .tag.off{background:#3a1f26;color:var(--no)}
  .tag.v-boa{background:#16332a;color:var(--ok)}
  .tag.v-ruim{background:#3a1f26;color:var(--no)}
  .veredito{border:1px solid var(--line);border-radius:8px;padding:12px;max-width:640px;background:#11151d}
  .lin{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
  .ou{font-size:12px;color:var(--dim)}
  button.boa{background:var(--ok);border-color:var(--ok);color:#06231a;font-weight:600}
  .cats button{font-size:12px;padding:5px 10px}
  .cats button.on{background:var(--no);border-color:var(--no);color:#2a0d0d;font-weight:600}
  textarea{width:100%;background:var(--card);border:1px solid var(--line);color:var(--txt);
    padding:8px;border-radius:6px;font:13px system-ui;resize:vertical;margin-bottom:8px}
</style></head><body>
<header>
  <h1>🎞 Bancada</h1>
  <a href="/r/cortar" style="color:#4ea1ff;text-decoration:none;font-size:13px">✂️ marcar cortes →</a>
  <span class="cont" id="cont">carregando…</span>
  <button id="bPre">⤓ pré-carregar tudo</button>
  <span class="cont" id="pre"></span>
  <span style="flex:1"></span>
  <input id="tok" type="password" placeholder="ADMIN_TOKEN (pra tirar do ar)">
</header>
<div class="wrap">
  <div class="lista" id="lista"></div>
  <div class="palco">
    <div id="vazio" class="vazio">Clique numa peça à esquerda.<br><br>
      Os botões <b>início</b> e <b>fim</b> vão direto nas bordas — é onde o corte erra.</div>
    <div id="palco" style="display:none">
      <video id="v" controls playsinline></video>
      <div class="btns">
        <button class="pri" id="bIni">⏮ ver o início</button>
        <button class="pri" id="bFim">⏭ ver o fim (−3s)</button>
        <button id="bRe">↻ de novo</button>
      </div>
      <div class="veredito">
        <div class="lin">
          <button class="boa" id="bBoa">👍 boa — deixa no ar</button>
          <span class="ou">ou marque o que deu errado:</span>
        </div>
        <div class="lin cats" id="cats"></div>
        <textarea id="obs" rows="2" placeholder="o que exatamente ficou ruim? (opcional, mas é o que me ensina)"></textarea>
        <div class="lin"><button class="dang" id="bRuim">✖ ruim — tira do ar e registra</button>
          <span class="cont" id="jaTem"></span></div>
      </div>
      <div class="meta" id="meta"></div>
    </div>
  </div>
</div>
<script>
const $=(s)=>document.querySelector(s)
let itens=[], sel=null, hls=null
const fmt=(s)=>s<60?s.toFixed(1)+'s':Math.floor(s/60)+'m'+String(Math.round(s%60)).padStart(2,'0')
const tok=()=>{const t=$('#tok').value.trim(); if(t) localStorage.setItem('tk',t); return t}
$('#tok').value = localStorage.getItem('tk') ?? ''

async function carrega(){
  itens = await (await fetch('/revisao/lista')).json()
  const no = itens.filter(i=>i.status==='ready').length
  const rev = itens.filter(i=>i.veredito).length
  $('#cont').textContent = itens.length+' peças · '+no+' no ar · '+rev+' revisadas'
  $('#lista').innerHTML = itens.map((i,n)=>
    '<div class="it '+(i.status!=='ready'?'off':'')+'" data-n="'+n+'">'+
      '<span class="dur">'+fmt(i.duracao_seg)+'</span>'+
      '<span class="nm">'+i.titulo.replace(/</g,'&lt;')+
        (i.veredito==='boa'?' <span class="tag v-boa">👍</span>':'')+
        (i.veredito==='ruim'?' <span class="tag v-ruim">✖ '+(i.categoria??'ruim').replace(/_/g,' ')+'</span>':'')+
        (i.status!=='ready'&&!i.veredito?' <span class="tag off">fora do ar</span>':'')+
        '<br><span class="id">'+i.id+'</span></span>'+
    '</div>').join('')
  document.querySelectorAll('.it').forEach(e=>e.onclick=()=>abre(+e.dataset.n))
}
// ── pré-carga ──────────────────────────────────────────────────────────────
// Medido: um segmento de 2MB sai do Worker em 0.21s (0.19s até o 1º byte). O
// servidor NÃO é o gargalo — o travamento vem de pedir o segmento só na hora do
// seek. Como a resposta do /media/* vem com immutable + max-age de 1 ano, um
// fetch() simples já joga no cache do navegador e o hls.js pega de graça.
// (sem crase neste comentário: ele vive DENTRO do template literal da página,
//  e crase fecha o template — foi assim que o build quebrou uma vez)
const jaPre = new Set()
async function preCarrega(it){
  if(!it || jaPre.has(it.id)) return
  jaPre.add(it.id)
  for(let i=0;i<it.segment_count;i++){
    const u='/media/'+it.id+'/seg'+String(i).padStart(5,'0')+'.ts'
    try{ await fetch(u,{cache:'force-cache'}) }catch(e){}
  }
}
function preVizinhos(n){
  // as 3 seguintes: ele desce a lista em ordem, então essas são as prováveis
  for(let k=n+1;k<=n+3 && k<itens.length;k++) preCarrega(itens[k])
}

function abre(n){
  sel=itens[n]
  document.querySelectorAll('.it').forEach((e,i)=>e.classList.toggle('sel',i===n))
  $('#vazio').style.display='none'; $('#palco').style.display=''
  const v=$('#v'), src='/revisao/'+encodeURIComponent(sel.id)+'/playlist.m3u8'
  if(hls){hls.destroy();hls=null}
  if(window.Hls&&Hls.isSupported()){
    // Peça é curta (1-4 segmentos, 2-8MB): buffera ELA INTEIRA. Assim o "ver o
    // fim" é instantâneo em vez de disparar um fetch no meio do seek.
    hls=new Hls({maxBufferLength:120,maxMaxBufferLength:180,startFragPrefetch:true})
    hls.loadSource(src); hls.attachMedia(v)
    // ⚠️ só tocar DEPOIS do manifesto — era o bug: eu chamava play() na linha
    // seguinte ao loadSource, quando ainda não havia nada carregado. O
    // ThePlayer.vue do projeto já fazia certo e eu não copiei.
    hls.on(Hls.Events.MANIFEST_PARSED,()=>v.play().catch(()=>{}))
  } else if(v.canPlayType('application/vnd.apple.mpegurl')){
    v.src=src; v.addEventListener('loadedmetadata',()=>v.play().catch(()=>{}),{once:true})
  }
  $('#meta').innerHTML='<b>'+sel.titulo.replace(/</g,'&lt;')+'</b><br>'+
    'id <b>'+sel.id+'</b> · duração <b>'+fmt(sel.duracao_seg)+'</b> ('+sel.segment_count+' segmentos) · canal <b>'+(sel.canal??'—')+'</b><br>'+
    'estado <b>'+(sel.status==='ready'?'no ar':'fora do ar')+'</b>'+
    '<br><span style="color:#ffb454">⚠ o pipeline pada tudo pra múltiplo de 10s com PRETO — '+
    'se sobrar preto no fim, é a regra dos 10s, não corte errado.</span>'
  // o que ele já disse desta peça — senão revisa duas vezes sem saber
  $('#jaTem').textContent = sel.veredito
    ? '— já marcada: '+(sel.veredito==='boa'?'👍 boa':'✖ '+(sel.categoria??'ruim').replace(/_/g,' '))+
      (sel.motivo?' ("'+sel.motivo+'")':'')
    : ''
  preVizinhos(n)
}
$('#bIni').onclick=()=>{const v=$('#v');v.currentTime=0;v.play()}
// −3s: tempo de ver o fecho da peça. Se ela termina no meio da locução, ou se
// entra um pedaço do vizinho, é aqui que aparece.
$('#bFim').onclick=()=>{const v=$('#v');v.currentTime=Math.max(0,(sel?.duracao_seg??v.duration)-3);v.play()}
$('#bRe').onclick=()=>{const v=$('#v');v.currentTime=0;v.play()}
// Cada categoria aponta pra uma parte ESPECÍFICA do motor — é isso que me deixa
// consertar o lugar certo em vez de adivinhar. Texto livre eu leio, mas não
// conto; categoria eu conto e vejo qual erro domina.
const CATS=[
  ['corte_no_meio','✂️ cortada no meio','o corte caiu dentro da peça — faltou um limite'],
  ['pedaco_vizinho','🔗 tem pedaço do vizinho','entrou sobra do comercial de antes/depois'],
  ['nao_e_peca','📺 não é peça','é bloco, programa ou trecho solto'],
  ['nome_errado','🏷 nome errado','o nome não bate com o conteúdo'],
  ['preto_demais','⬛ preto demais','a regra dos 10s pesou (arquitetural)'],
  ['outro','… outro','descreva embaixo'],
]
let cat=null
$('#cats').innerHTML=CATS.map(([k,r,t])=>'<button data-k="'+k+'" title="'+t+'">'+r+'</button>').join('')
document.querySelectorAll('#cats button').forEach(b=>b.onclick=()=>{
  cat = cat===b.dataset.k ? null : b.dataset.k
  document.querySelectorAll('#cats button').forEach(x=>x.classList.toggle('on',x.dataset.k===cat))
})
async function nota(veredito){
  if(!sel) return
  const t=tok(); if(!t) return alert('cole o ADMIN_TOKEN no topo — sem ele não dá pra registrar')
  if(veredito==='ruim' && !cat && !$('#obs').value.trim())
    return alert('marque uma categoria ou escreva o motivo — é isso que me ensina o que consertar')
  const r=await fetch('/revisao/'+encodeURIComponent(sel.id)+'/nota',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+t},
    body:JSON.stringify({veredito,categoria:cat,motivo:$('#obs').value.trim()})})
  if(!r.ok) return alert('falhou ('+r.status+'): '+(await r.text()).slice(0,140))
  const n=itens.indexOf(sel)
  await carrega()
  $('#obs').value=''; cat=null
  document.querySelectorAll('#cats button').forEach(x=>x.classList.remove('on'))
  // vai direto pra próxima: ele está varrendo a lista, não quer clicar de novo
  if(n+1<itens.length) abre(n+1)
}
$('#bBoa').onclick=()=>nota('boa')
$('#bRuim').onclick=()=>nota('ruim')
// Varredura sequencial: ~51 peças × 2-8MB seria uma enxurrada se disparasse
// tudo de uma vez. Uma por vez mantém a banda livre pro que está tocando.
$('#bPre').onclick=async()=>{
  $('#bPre').disabled=true
  for(const [n,it] of itens.entries()){
    $('#pre').textContent='pré-carregando '+(n+1)+'/'+itens.length+'…'
    await preCarrega(it)
  }
  $('#pre').textContent='✓ tudo em cache — nenhuma vai travar'
  $('#bPre').disabled=false
}
carrega()
</script></body></html>`

revisao.get('/', (c) => c.html(PAGINA))
// a etapa de ajuste: ele marca onde cada peça termina, o ffmpeg corta ali
revisao.get('/cortar', (c) => c.html(MARCADOR))
