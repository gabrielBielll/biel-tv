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

type Bindings = { DB: D1Database }

export const revisao = new Hono<{ Bindings: Bindings }>()
revisao.use('*', cors())

const SEG = 10 // s por segmento — a regra de ouro do pipeline
const pad5 = (n: number) => String(n).padStart(5, '0')

/** As peças, mais novas primeiro. Público e read-only: o /media/* já é aberto
 *  (é o que o player do canal consome), então listar não expõe nada novo. */
revisao.get('/lista', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.status, m.duracao_seg, m.segment_count, m.created_at,
            COALESCE(json_extract(m.metadata,'$.title'), json_extract(m.metadata,'$.titulo'), m.id) AS titulo,
            mc.channel_id AS canal
     FROM media_items m
     LEFT JOIN media_channels mc ON mc.media_id = m.id
     WHERE m.tipo = 'comercial'
     ORDER BY m.created_at DESC, m.id`,
  ).all()
  return c.json(results)
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
</style></head><body>
<header>
  <h1>🎞 Bancada — peças recortadas</h1>
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
        <button class="dang" id="bOff">✖ tirar do ar</button>
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
  $('#cont').textContent = itens.length+' peças · '+no+' no ar'
  $('#lista').innerHTML = itens.map((i,n)=>
    '<div class="it '+(i.status!=='ready'?'off':'')+'" data-n="'+n+'">'+
      '<span class="dur">'+fmt(i.duracao_seg)+'</span>'+
      '<span class="nm">'+i.titulo.replace(/</g,'&lt;')+
        (i.status!=='ready'?' <span class="tag off">fora do ar</span>':'')+
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
  preVizinhos(n)
}
$('#bIni').onclick=()=>{const v=$('#v');v.currentTime=0;v.play()}
// −3s: tempo de ver o fecho da peça. Se ela termina no meio da locução, ou se
// entra um pedaço do vizinho, é aqui que aparece.
$('#bFim').onclick=()=>{const v=$('#v');v.currentTime=Math.max(0,(sel?.duracao_seg??v.duration)-3);v.play()}
$('#bRe').onclick=()=>{const v=$('#v');v.currentTime=0;v.play()}
$('#bOff').onclick=async()=>{
  if(!sel) return
  const t=tok(); if(!t) return alert('cole o ADMIN_TOKEN no topo pra poder tirar do ar')
  const novo = sel.status==='ready' ? 'disabled' : 'ready'
  const r=await fetch('/admin/media/'+encodeURIComponent(sel.id)+'/status',
    {method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+t},body:JSON.stringify({status:novo})})
  if(!r.ok) return alert('falhou ('+r.status+'): '+(await r.text()).slice(0,120))
  await carrega(); alert(novo==='disabled'?'tirada do ar':'de volta ao ar')
}
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
