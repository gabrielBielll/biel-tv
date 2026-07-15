// Tela de marcação de cortes — o Gabriel assiste o compilado e marca onde cada
// peça COMEÇA e ONDE TERMINA. Pedido dele (2026-07-15): "quando eu subir um
// comercial você pode jogar ele para essa etapa de ajuste nessa aba; aí eu passo
// lá, dou uma revisão, e depois ele pode terminar de ajustar — não tomou muito
// do meu tempo".
//
// ⚠️ POR QUE O HUMANO MARCA, E NÃO A MÁQUINA (não é preguiça de engenharia):
// medido contra o gabarito dele no compilado de 390s —
//     cena           → acerta 5/6, mas dispara 138× em 390s (96% falso)
//     silêncio       → 3/6
//     buraco de fala → 1/6, e o único tem 33s de largura
//     preto          → 0/6 (2 ocorrências no arquivo inteiro)
// Comercial de 2004 emenda direto: sem preto, sem silêncio, e com corte de cena
// idêntico aos cortes de DENTRO do anúncio. Tentar espaçar as cenas pela grade
// de 15/30/60 também falhou (3/6) — com um corte a cada 2.8s existe um ponto
// perto de qualquer lugar que se procure, então a "estrutura encontrada" era a
// que eu mandei encontrar. O placar do automático: 24 peças, 23 reprovadas.
//
// Ele, assistindo, acertou tudo em minutos. Então: ele marca, o ffmpeg corta
// com precisão de frame (medido: erro ≤ 1 frame), e o motor vira opinião.
//
// ── por que INÍCIO+FIM e não uma marca só (2026-07-15) ────────────────────────
// A v1 tinha uma tecla (M) que marcava FRONTEIRA: o mesmo instante fechava uma
// peça e abria a próxima. Ele: "fica confuso saber quando começa e quando
// termina um quadro". Não é só a tela — o modelo estava errado. Fronteira
// obriga o compilado inteiro a virar peça, e o material dele tem LIXO no meio:
// "aos 2:30 começa o power rangers força animal e vai até 2:59 (…) o resto é
// lixo só recortes". Com ini+fim o buraco é dizível, e sobra onde pendurar o
// NOME — que é o que ele sabe e a máquina não (o whisper inventou "Iue Falante").
// O PLANO do scripts/recorta-marcado.mjs já era [{ini,fim,nome}] na unha; agora
// a tela produz o mesmo formato que o cortador consome.
//
// ── e por que a régua própria em vez do <video controls> ──────────────────────
// Ele: "se eu mudar o momento do vídeo clicando no player a marcação que fiz com
// o m sai; então talvez adicionar uma forma de escolher o momento do vídeo
// diferente". Estava certo, e a causa é focal: clicar no player nativo dá o FOCO
// pro controle do Chrome (shadow DOM), e a partir daí as teclas da página
// brigam com as dele. Reproduzido com playwright, na página no ar:
//     seta ← com o player focado  → −7.19s (o nosso −1s + o −5s nativo; o
//                                   preventDefault chega tarde: o handler do
//                                   shadow DOM roda ANTES de bubblar)
//     espaço com o player focado  → nada (nós damos play, o nativo dá pause)
//     seta com o <select> focado  → troca de compilado e APAGA tudo, sem aviso
// Esse último é o que comia o trabalho dele — e explica a tabela cortes_marcados
// VAZIA em produção: ele marcava, perdia, e nunca chegava a salvar.
// Fix de raiz: sem `controls`, o player não tem mais o que focar; a régua abaixo
// é nossa (pointer events), desenha as peças e o playhead, e as teclas passam a
// ter dono único. Rascunho em localStorage por compilado fecha o resto — trocar
// de vídeo (de propósito ou sem querer) não perde mais nada.
export const MARCADOR = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Marcar cortes</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<style>
  :root{--bg:#0d0f14;--card:#161a22;--line:#232936;--txt:#e6e9ef;--dim:#8b94a7;--ac:#4ea1ff;--ok:#3ecf8e;--no:#ff5c5c;--mk:#ffb454}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
  header{padding:12px 18px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  h1{font-size:15px;margin:0;font-weight:600}
  a{color:var(--ac);text-decoration:none;font-size:13px}
  .cont{font-size:12px;color:var(--dim)}
  input{background:var(--card);border:1px solid var(--line);color:var(--txt);padding:6px 9px;border-radius:6px;font-size:12px;width:190px}
  .main{padding:16px 18px;max-width:920px}
  select{background:var(--card);border:1px solid var(--line);color:var(--txt);padding:7px 10px;border-radius:6px;font-size:13px;max-width:100%}
  /* max-height: sem isto o player come a tela toda e a régua + a tabela caem
     abaixo da dobra — ele precisa ver o vídeo E as marcas ao mesmo tempo */
  video{width:100%;max-height:44vh;background:#000;border-radius:8px;display:block;margin:12px 0 0;cursor:pointer}
  .rel{font-variant-numeric:tabular-nums;font-size:30px;font-weight:600;letter-spacing:1px}
  .rel small{font-size:14px;color:var(--dim);font-weight:400}
  .btns{display:flex;gap:8px;margin:12px 0;flex-wrap:wrap;align-items:center}
  button{background:var(--card);color:var(--txt);border:1px solid var(--line);padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px}
  button:hover{border-color:var(--ac)}
  button.mk{font-weight:700;font-size:15px;padding:11px 18px}
  button#bI{background:var(--mk);border-color:var(--mk);color:#241800}
  button#bF{background:var(--card);border-color:var(--mk);color:var(--mk)}
  button#bF.arm{background:var(--mk);color:#241800;animation:pulsa 1.1s infinite}
  button#bI.arm{background:var(--card);color:var(--mk)}
  @keyframes pulsa{50%{opacity:.55}}
  button.go{background:var(--ok);border-color:var(--ok);color:#06231a;font-weight:700}
  /* cor explícita: dentro do botão laranja o kbd herdava o texto escuro (#241800)
     por cima do próprio fundo quase preto e o "I" sumia — invisível no print */
  kbd{background:#0a0d12;color:var(--txt);border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:1px 6px;font:11px ui-monospace,monospace}
  /* ── a régua: nossa, não a do Chrome. Clicar/arrastar aqui escolhe o momento
       sem entregar o foco pro controle nativo (era daí que vinha o bug). ── */
  .tl{position:relative;height:62px;background:#11151d;border:1px solid var(--line);
      border-radius:8px;margin:10px 0 4px;cursor:crosshair;overflow:hidden;touch-action:none;user-select:none}
  .tl .bf{position:absolute;left:0;right:0;top:0;bottom:19px}
  .tl .bf div{position:absolute;top:0;bottom:0;background:#1b2333}
  .pc{position:absolute;top:3px;bottom:22px;background:rgba(62,207,142,.28);border:1px solid var(--ok);
      border-radius:3px;overflow:hidden;pointer-events:none}
  .pc b{position:absolute;left:4px;top:1px;font-size:10px;color:#b7f2d8;font-weight:600;white-space:nowrap}
  #ab{position:absolute;top:3px;bottom:22px;background:rgba(255,180,84,.26);border:1px dashed var(--mk);
      border-radius:3px;display:none;pointer-events:none}
  #ph{position:absolute;top:0;bottom:0;width:2px;background:var(--no);pointer-events:none;box-shadow:0 0 6px var(--no)}
  #rg{position:absolute;left:0;right:0;bottom:0;height:19px;border-top:1px solid var(--line);pointer-events:none}
  #rg i{position:absolute;font:9px ui-monospace,monospace;color:var(--dim);font-style:normal;transform:translateX(-50%);padding-top:3px}
  #rg i:before{content:'';position:absolute;left:50%;top:-4px;width:1px;height:4px;background:var(--line)}
  .abre{color:var(--mk);font-size:12px;min-height:18px}
  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
  th{text-align:left;color:var(--dim);font-weight:500;font-size:11px;padding:6px;border-bottom:1px solid var(--line)}
  td{padding:5px 6px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;white-space:nowrap}
  tr:hover{background:var(--card)}
  .grade{color:var(--ok);font-weight:600}
  .fora{color:var(--mk)}
  .sk{color:var(--ac);cursor:pointer;text-decoration:underline dotted}
  .bur td{color:var(--dim);font-size:11px;font-style:italic;border-bottom:none;padding:2px 6px}
  .ovl{background:#3a1f26}
  .ovl td:first-child:after{content:' ⚠'}
  .vaz{color:var(--dim);padding:14px}
  input.nm{width:100%;font-size:12px;padding:4px 7px}
  .mini{background:none;border:none;color:var(--dim);cursor:pointer;padding:2px 5px;font-size:12px}
  .mini:hover{color:var(--no)}
  .dica{color:var(--dim);font-size:12px;background:var(--card);border-left:2px solid var(--ac);padding:9px 12px;border-radius:0 6px 6px 0;margin:10px 0}
  .rasc{color:var(--mk);font-size:12px;background:#241d10;border-left:2px solid var(--mk);padding:8px 12px;border-radius:0 6px 6px 0;margin:8px 0}
</style></head><body>
<header>
  <h1>✂️ Marcar cortes</h1>
  <a href="/r">← bancada</a>
  <span class="cont" id="st"></span>
  <span style="flex:1"></span>
  <input id="tok" type="password" placeholder="ADMIN_TOKEN">
</header>
<div class="main">
  <select id="sel"></select>
  <video id="v" playsinline></video>
  <div class="tl" id="tl">
    <div class="bf" id="bf"></div>
    <div id="pcs"></div>
    <div id="ab"></div>
    <div id="ph"></div>
    <div id="rg"></div>
  </div>
  <div class="rel"><span id="rel">0:00.00</span> <small id="dur"></small></div>
  <div class="btns">
    <button class="mk" id="bI">⟦ corte INÍCIO &nbsp;<kbd>I</kbd></button>
    <button class="mk" id="bF">⟧ corte FIM &nbsp;<kbd>F</kbd></button>
    <button id="bP">⏯ <kbd>espaço</kbd></button>
  </div>
  <div class="abre" id="abre"></div>
  <div class="btns">
    <button id="b1">−1s <kbd>←</kbd></button>
    <button id="b2">+1s <kbd>→</kbd></button>
    <button id="b5">−0.5s <kbd>shift ←</kbd></button>
    <button id="b6">+0.5s <kbd>shift →</kbd></button>
    <button id="b3">−0.1s <kbd>,</kbd></button>
    <button id="b4">+0.1s <kbd>.</kbd></button>
  </div>
  <div class="dica">
    Uma peça = <b>dois</b> cliques: <kbd>I</kbd> onde ela <b>começa</b>, <kbd>F</kbd> onde ela <b>termina</b>.
    O que ficar de fora é descartado — é pra isso que serve o buraco entre uma peça e outra
    ("o resto é lixo só recortes"). <kbd>Esc</kbd> cancela a peça aberta.<br>
    Pra escolher o momento, clique ou arraste <b>na régua</b> aí em cima (a barra do player saiu de
    propósito: era ela que embaralhava as teclas e comia as marcas).<br>
    A coluna <b>duração</b> avisa quando a peça fecha em 15/30/60s, que é como comercial
    de TV é vendido — se der 29.5s, provavelmente você acertou.<br>
    Depois de escrever o nome, aperte <kbd>Enter</kbd> pra voltar aos atalhos (enquanto o
    campo está ativo, o <kbd>I</kbd> e o <kbd>F</kbd> viram letra no nome).
  </div>
  <div class="rasc" id="rasc" style="display:none">
    ✎ rascunho local restaurado — você marcou isto e não salvou.
    <a href="#" id="bRasc">descartar e voltar ao que está salvo</a>
  </div>
  <table><thead><tr><th style="width:26px">#</th><th style="width:74px">início</th><th style="width:74px">fim</th>
    <th style="width:104px">duração</th><th>nome da peça <span class="cont">(opcional — em branco, a IA nomeia)</span></th>
    <th style="width:26px"></th></tr></thead>
    <tbody id="tb"></tbody></table>
  <div class="btns" style="margin-top:14px">
    <button class="go" id="bSalvar">💾 salvar peças</button>
    <span class="cont" id="resumo"></span>
    <span class="cont" id="msg"></span>
  </div>
</div>
<script>
const $=(s)=>document.querySelector(s)
const esc=(s)=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')
const r2=(x)=>Math.round(x*100)/100
let comps=[], cur=null, pecas=[], aberta=null, hls=null, arrastando=false
const GRADE=[10,15,30,60], TOL=1.5
const t2s=(t)=>{const m=Math.floor(t/60),s=t%60;return m+':'+(s<10?'0':'')+s.toFixed(2)}
const tok=()=>{const t=$('#tok').value.trim(); if(t) localStorage.setItem('tk',t); return t}
$('#tok').value=localStorage.getItem('tk')??''

let avisoT=null
function aviso(m,cor){
  $('#msg').textContent=m; $('#msg').style.color=cor||'#ffb454'
  clearTimeout(avisoT); avisoT=setTimeout(()=>{$('#msg').textContent=''},4500)
}

// ── rascunho: o seguro contra perder trabalho ──────────────────────────────
// A tabela em produção estava vazia porque ele marcava e perdia antes de salvar.
// Agora cada mudança cai no localStorage por compilado; trocar de vídeo, fechar
// a aba ou recarregar não custa mais nada.
const rk=()=>'rasc:'+cur.id
const salvaRasc=()=>{try{localStorage.setItem(rk(),JSON.stringify(pecas))}catch(e){}}

async function carrega(){
  comps=await (await fetch('/revisao/compilados')).json()
  $('#sel').innerHTML=comps.map((c,i)=>'<option value="'+i+'">'+
    Math.round(c.duracao_seg)+'s — '+esc(String(c.titulo).slice(0,60))+
    (c.pecas?' ✓ '+JSON.parse(c.pecas).length+' peças':'')+'</option>').join('')
  abre(0)
}
function abre(i){
  cur=comps[i]; aberta=null; $('#abre').textContent=''; armaBotoes()
  const doServidor=cur.pecas?JSON.parse(cur.pecas):[]
  let rasc=null
  try{const s=localStorage.getItem(rk()); if(s) rasc=JSON.parse(s)}catch(e){}
  const temRasc=Array.isArray(rasc)&&JSON.stringify(rasc)!==JSON.stringify(doServidor)
  pecas=temRasc?rasc:doServidor
  $('#rasc').style.display=temRasc?'':'none'
  const v=$('#v'), src='/revisao/'+encodeURIComponent(cur.id)+'/playlist.m3u8'
  if(hls){hls.destroy();hls=null}
  if(window.Hls&&Hls.isSupported()){
    hls=new Hls({maxBufferLength:300,maxMaxBufferLength:600})
    hls.loadSource(src); hls.attachMedia(v)
  } else { v.src=src }
  $('#dur').textContent='de '+t2s(cur.duracao_seg)
  $('#st').textContent=cur.corte_status==='pronto'?('já cortado: '+cur.n_pecas+' peças'):''
  regua(); pinta()
}
/** marcas de minuto na régua — passo que não vira sopa de números */
function regua(){
  const d=cur.duracao_seg, passo=d<=120?15:d<=400?30:60
  let h=''
  for(let t=passo;t<d-2;t+=passo)
    h+='<i style="left:'+(t/d*100)+'%">'+Math.floor(t/60)+':'+String(Math.round(t%60)).padStart(2,'0')+'</i>'
  $('#rg').innerHTML=h
}
function desenhaTL(){
  const d=cur.duracao_seg
  $('#pcs').innerHTML=pecas.map((p,i)=>
    '<div class="pc" style="left:'+(p.ini/d*100)+'%;width:'+((p.fim-p.ini)/d*100)+'%">'+
      '<b>'+(i+1)+(p.nome?' '+esc(p.nome):'')+'</b></div>').join('')
}
function pinta(){
  pecas.sort((a,b)=>a.ini-b.ini)
  desenhaTL()
  let h='', total=0, sobrepoe=false
  if(!pecas.length) h='<tr><td colspan="6" class="vaz">nenhuma peça — aperte <b>I</b> onde ela começa e <b>F</b> onde ela termina</td></tr>'
  pecas.forEach((p,i)=>{
    const d=p.fim-p.ini; total+=d
    const slot=GRADE.find(g=>Math.abs(d-g)<=TOL)
    const ovl=i>0&&p.ini<pecas[i-1].fim-0.01
    if(ovl) sobrepoe=true
    // o buraco é dado, não erro: é o lixo que ele mandou jogar fora
    const bur=i>0?p.ini-pecas[i-1].fim:p.ini
    if(bur>0.5) h+='<tr class="bur"><td></td><td colspan="5">⋯ '+bur.toFixed(1)+'s descartados</td></tr>'
    h+='<tr'+(ovl?' class="ovl"':'')+'><td>'+(i+1)+'</td>'+
      '<td class="sk" data-t="'+p.ini+'" title="ir pra cá">'+t2s(p.ini)+'</td>'+
      '<td class="sk" data-t="'+p.fim+'" title="ir pra cá">'+t2s(p.fim)+'</td>'+
      '<td class="'+(slot?'grade':'fora')+'">'+d.toFixed(2)+'s'+(slot?' ✓ '+slot+'s':'')+'</td>'+
      '<td><input class="nm" data-i="'+i+'" value="'+esc(p.nome??'')+'" placeholder="(sem nome — a IA nomeia)"></td>'+
      '<td><button class="mini" data-i="'+i+'" title="apagar">✕</button></td></tr>'
  })
  if(pecas.length){
    const sobra=cur.duracao_seg-pecas[pecas.length-1].fim
    if(sobra>0.5) h+='<tr class="bur"><td></td><td colspan="5">⋯ '+sobra.toFixed(1)+'s descartados (até o fim)</td></tr>'
  }
  $('#tb').innerHTML=h
  document.querySelectorAll('.mini').forEach(b=>b.onclick=()=>{pecas.splice(+b.dataset.i,1);pinta()})
  document.querySelectorAll('.sk').forEach(e=>e.onclick=()=>{$('#v').currentTime=+e.dataset.t})
  // nome NÃO re-renderiza a tabela: repintar a cada tecla tiraria o foco do input
  document.querySelectorAll('input.nm').forEach(e=>{
    e.oninput=()=>{pecas[+e.dataset.i].nome=e.value; salvaRasc(); desenhaTL()}
  })
  $('#resumo').textContent=pecas.length
    ? pecas.length+' peças · '+total.toFixed(1)+'s aproveitados de '+Math.round(cur.duracao_seg)+'s'+
      (sobrepoe?' · ⚠ tem peça sobreposta':'')
    : ''
  salvaRasc()
}
// ── o laço de desenho: playhead, relógio e a peça em construção ────────────
// rAF em vez de ontimeupdate (que só dispara ~4×/s e faz o playhead pular).
let bfKey=''
function tick(){
  const v=$('#v')
  if(cur){
    const d=cur.duracao_seg, t=v.currentTime
    $('#rel').textContent=t2s(t)
    $('#ph').style.left=Math.min(100,t/d*100)+'%'
    const ab=$('#ab')
    if(aberta!==null){
      const fim=Math.max(t,aberta)
      // 'block', não '': o CSS já declara display:none no #ab, e limpar o estilo
      // inline voltava justamente pra ele — o bloco nunca aparecia
      ab.style.display='block'; ab.style.left=(aberta/d*100)+'%'; ab.style.width=((fim-aberta)/d*100)+'%'
    } else ab.style.display='none'
    // o que já está em buffer — pra ele saber que travar num ponto é download,
    // não bug (compilado de 6min = 8 segmentos de 2MB)
    let k='',bh=''
    for(let i=0;i<v.buffered.length;i++){
      const a=v.buffered.start(i), b=v.buffered.end(i)
      k+=a.toFixed(1)+'-'+b.toFixed(1)+';'
      bh+='<div style="left:'+(a/d*100)+'%;width:'+((b-a)/d*100)+'%"></div>'
    }
    if(k!==bfKey){bfKey=k;$('#bf').innerHTML=bh}
  }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

// ── escolher o momento: régua própria, pointer events ──────────────────────
// É a "forma diferente de escolher o momento" que ele pediu. Como não é o
// controle nativo, o foco nunca sai do body e as teclas continuam nossas.
const tl=$('#tl')
function seekTL(e){
  if(!cur) return
  const r=tl.getBoundingClientRect()
  const x=Math.min(Math.max(e.clientX-r.left,0),r.width)
  $('#v').currentTime=x/r.width*cur.duracao_seg
}
tl.onpointerdown=(e)=>{arrastando=true;tl.setPointerCapture(e.pointerId);seekTL(e)}
tl.onpointermove=(e)=>{if(arrastando)seekTL(e)}
tl.onpointerup=tl.onpointercancel=()=>{arrastando=false}

const toca=()=>{const v=$('#v');v.paused?v.play().catch(()=>{}):v.pause()}
$('#v').onclick=toca
function armaBotoes(){
  $('#bI').classList.toggle('arm',aberta!==null)
  $('#bF').classList.toggle('arm',aberta!==null)
}
function marcaIni(){
  aberta=r2($('#v').currentTime)
  $('#abre').textContent='⟦ peça aberta desde '+t2s(aberta)+' — aperte F onde ela termina (Esc cancela)'
  armaBotoes()
}
function marcaFim(){
  if(aberta===null) return aviso('marque o INÍCIO primeiro — tecla I')
  const f=r2($('#v').currentTime)
  if(f<=aberta+0.2) return aviso('o fim tem que vir depois do início — avance o vídeo')
  pecas.push({ini:aberta,fim:f,nome:''})
  const d=f-aberta
  aberta=null; $('#abre').textContent=''; armaBotoes(); pinta()
  const slot=GRADE.find(g=>Math.abs(d-g)<=TOL)
  aviso('✓ peça de '+d.toFixed(2)+'s'+(slot?' — fecha na grade de '+slot+'s':''),slot?'#3ecf8e':'#8b94a7')
}
function cancela(){
  if(aberta===null) return
  aberta=null; $('#abre').textContent=''; armaBotoes(); aviso('peça aberta cancelada')
}
$('#bI').onclick=marcaIni
$('#bF').onclick=marcaFim
$('#bP').onclick=toca
const nudge=(d)=>{const v=$('#v');v.currentTime=Math.max(0,Math.min(cur?cur.duracao_seg:1e9,v.currentTime+d))}
$('#b1').onclick=()=>nudge(-1); $('#b2').onclick=()=>nudge(1)
// meio segundo: o material CAI em meio segundo. O próprio Gabriel anotou
// "5:43 e meio quase 5:44" e "0:52 quase 0:53" — ele já estava trabalhando
// nessa resolução no chat; a tela é que só tinha 1s e 0.1s.
$('#b5').onclick=()=>nudge(-0.5); $('#b6').onclick=()=>nudge(0.5)
$('#b3').onclick=()=>nudge(-0.1); $('#b4').onclick=()=>nudge(0.1)
// os botões não podem ficar com o foco: senão o espaço "clica" o último botão
// usado em vez de dar play (o navegador ativa botão focado com espaço)
document.querySelectorAll('.btns button').forEach(b=>b.addEventListener('click',()=>b.blur()))

addEventListener('keydown',(e)=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT'||e.target.tagName==='TEXTAREA') return
  const k=e.key.toLowerCase()
  // shift+seta = meio segundo. Escolhido por ser independente de layout: no
  // ABNT2 as teclas [ ] < > ficam em lugares diferentes do US, e seta+shift é
  // igual em todo teclado.
  if(k==='arrowleft'){e.preventDefault();nudge(e.shiftKey?-0.5:-1)}
  else if(k==='arrowright'){e.preventDefault();nudge(e.shiftKey?0.5:1)}
  else if(k==='i'){e.preventDefault();marcaIni()}
  else if(k==='f'){e.preventDefault();marcaFim()}
  else if(k==='m'){e.preventDefault();aviso('o M virou dois: I marca o INÍCIO da peça, F marca o FIM')}
  else if(k==='escape'){e.preventDefault();cancela()}
  else if(k===','||k==='<'){e.preventDefault();nudge(-0.1)}
  else if(k==='.'||k==='>'){e.preventDefault();nudge(0.1)}
  else if(k===' '){e.preventDefault();toca()}
})
// Enter/Esc devolve o teclado pra tela. Sem isto, depois de nomear uma peça o
// foco fica no campo e o I e o F viram TEXTO dentro dele — o nome sai "Tempestade
// Ninjaif" e a marcação seguinte simplesmente não acontece, sem nenhum aviso.
// (achado no teste: a peça que eu ia marcar depois de nomear nunca foi criada)
document.addEventListener('keydown',(e)=>{
  if(e.target.tagName!=='INPUT') return
  if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur()}
})
// blur no select: focado, a seta trocava de compilado e apagava tudo em silêncio
$('#sel').onchange=(e)=>{abre(+e.target.value);e.target.blur()}
$('#bRasc').onclick=(e)=>{e.preventDefault();localStorage.removeItem(rk());abre(comps.indexOf(cur))}
$('#bSalvar').onclick=async()=>{
  const t=tok(); if(!t) return alert('cole o ADMIN_TOKEN no topo')
  if(!pecas.length) return alert('marque pelo menos uma peça (I = início, F = fim)')
  if(aberta!==null&&!confirm('tem uma peça aberta (início marcado, fim não) — ela não vai ser salva. salvar assim mesmo?')) return
  const r=await fetch('/revisao/'+encodeURIComponent(cur.id)+'/pecas',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+t},
    body:JSON.stringify({pecas})})
  if(!r.ok) return alert('falhou ('+r.status+'): '+(await r.text()).slice(0,160))
  const j=await r.json()
  localStorage.removeItem(rk()) // salvou ⇒ o rascunho cumpriu o papel
  aviso('✓ salvo: '+j.pecas.length+' peças — pode me avisar que eu corto','#3ecf8e')
  const id=cur.id
  await carrega()
  const n=comps.findIndex((c)=>c.id===id); if(n>=0){$('#sel').selectedIndex=n;abre(n)}
}
carrega()
</script></body></html>`
