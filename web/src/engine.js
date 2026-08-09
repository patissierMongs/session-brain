/* AUTO-GENERATED from mockup-15 — engine core. Edited via scripted transforms. */
import hljs from "./hl";
import { esc } from "./util";

export function mountSession(data){
  const AC = new AbortController();
  const SIG = { signal: AC.signal };
  const bodyNodes = [];
  const _bodyAppend = (el) => { document.body.appendChild(el); bodyNodes.push(el); return el; };
"use strict";
/* ================= demo data ================= */
const meta0 = data.meta || {};
function fmtSpan(a, b){
  const d=(s)=>s&&s.length>=10?s.slice(0,10):"";
  const t=(s)=>s&&s.length>=16?s.slice(11,16):"";
  if(!a&&!b) return "";
  return d(a)===d(b) ? `${d(a)} ${t(a)}\u2192${t(b)}` : `${d(a)}\u2192${d(b)}`;
}
function parsePlan(text){
  const m=/"plan"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text||"");
  let body=m?m[1]:"";
  body=body.replace(/\\n/g,"\n").replace(/\\"/g,'"').replace(/\\\\/g,"\\");
  if(!body) body=String(text||"").replace(/^Tool: ExitPlanMode\n?/,"");
  return { title:"구현 계획 (plan mode)", body };
}
function parseChoice(text, resultText){
  const q=/"question"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text||"");
  const opts=[];
  const re=/"label"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let mm;
  while((mm=re.exec(text||""))) opts.push(mm[1].replace(/\\"/g,'"'));
  const rt=String(resultText||"");
  return {
    q: q ? q[1].replace(/\\"/g,'"') : "선택지 (AskUserQuestion)",
    opts: (opts.length?opts:["(옵션을 복원할 수 없음 — 요약이 잘렸습니다)"]).map(label=>({ label, sel: !!label && rt.includes(label) })),
  };
}
function nextToolResultText(n){
  /* 같은 체인의 바로 다음 tool 노드(대개 tool_result 요약) */
  let c=n.children&&n.children.length?n.children[0]:null;
  for(let i=0;i<3&&c;i++){
    if(c.kind==="tool"&&c.text&&c.text.startsWith("\u2192")) return c.text;
    c=c.children&&c.children.length?c.children[0]:null;
  }
  return "";
}
const FORK_COLORS = ["#d95926","#199e70","#c98500","#d55181","#9085e9"];
const THREAD_W = 600, RAIL_MIN = 84;

/* ---------- tree build (from server API data) ---------- */
const nodes = new Map();
let ROOT = null;
{
  const hmOf = (ts) => (ts && ts.length >= 16 ? ts.slice(11, 16) : "");
  for (const l of (data.links || [])) {
    const m = data.messages ? data.messages[l.uuid] : null;
    nodes.set(l.uuid, {
      id: l.uuid,
      p: l.parent_uuid || null,
      role: l.role === "user" ? "user" : "assistant",
      kind: deriveKind(m),
      hm: hmOf(m && m.ts),
      ts: (m && m.ts) || "",
      text: m ? String(m.content || "") : "",
      hasContent: !!m,
      line: l.line_no || 0,
      children: [],
    });
  }
  nodes.forEach((n) => {
    if (n.p && nodes.has(n.p)) nodes.get(n.p).children.push(n);
  });
  let roots = [...nodes.values()].filter((n) => !n.p || !nodes.has(n.p));
  // 1) prune: subtrees with no content anywhere (dangling metadata chains —
  //    ai-title / queue-operation / last-prompt records linked but never indexed)
  const hasContentDeep = (n) => n.hasContent || n.children.some(hasContentDeep);
  const dropDeep = (n) => { nodes.delete(n.id); n.children.forEach(dropDeep); };
  const pruneKids = (n) => {
    n.children.filter((c) => !hasContentDeep(c)).forEach(dropDeep);
    n.children = n.children.filter((c) => nodes.has(c.id));
    n.children.forEach(pruneKids);
  };
  roots.filter((r) => !hasContentDeep(r)).forEach(dropDeep);
  roots = roots.filter((r) => nodes.has(r.id));
  roots.forEach(pruneKids);
  // 2) splice: content-less pass-through nodes (attachment/system/compact records
  //    that real logs chain parentUuid through). A single-child node without
  //    content is structure, not conversation — cut it out of the chain.
  const advance = (n) => { while (!n.hasContent && n.children.length === 1) { nodes.delete(n.id); n = n.children[0]; } return n; };
  const spliceKids = (n) => {
    n.children = n.children.map((c) => { const k = advance(c); k.p = n.id; return k; });
    n.children.forEach(spliceKids);
  };
  roots = roots.map((r) => { const k = advance(r); k.p = null; return k; });
  roots.forEach(spliceKids);
  nodes.forEach((n) => n.children.sort((x, y) => x.line - y.line));
  // 3) multiple roots are CONTINUATION segments (compaction boundaries, chain
  //    gaps), not forks — chain each segment onto the tip of the previous one.
  roots.sort((x, y) => x.line - y.line);
  if (!roots.length) roots = [{ id: "__empty", p: null, role: "assistant", kind: "text", hm: "", ts: "", text: "(빈 세션)", hasContent: true, line: 0, children: [] }];
  ROOT = roots[0];
  for (let i = 1; i < roots.length; i++) {
    let tip = ROOT;
    const st = [ROOT];
    while (st.length) { const n = st.pop(); if (n.line > tip.line) tip = n; n.children.forEach((c) => st.push(c)); }
    tip.children.push(roots[i]);
    roots[i].p = tip.id;
  }
  nodes.set(ROOT.id, ROOT);
  const order = [];
  const st = [ROOT];
  while (st.length) { const n = st.pop(); order.push(n); n.children.forEach((c) => st.push(c)); }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    n.maxLine = n.line;
    n.children.forEach((c) => { if (c.maxLine > n.maxLine) n.maxLine = c.maxLine; });
  }
}
function deriveKind(m) {
  if (!m) return "tool";
  if (m.kind === "thinking") return "think";
  if (m.kind === "tool") {
    const c = String(m.content || "");
    if (c.startsWith("Tool: ExitPlanMode")) return "plan";
    if (c.startsWith("Tool: AskUserQuestion")) return "choice";
    return "tool";
  }
  return "text";
}
function selectedChild(f){ return f.children.reduce((a,b)=>b.maxLine>a.maxLine?b:a, f.children[0]); }
function pathFrom(s){ const p=[]; let c=s; while(c){ p.push(c); if(!c.children.length) break; c=c.children.length>1?selectedChild(c):c.children[0]; } return p; }
function altsInPath(path){ const out=[]; path.forEach(n=>{ if(n.children.length>1){ const sel=selectedChild(n); n.children.filter(c=>c!==sel).forEach(alt=>out.push({anchor:n, alt})); } }); return out; }
function subtreeStats(root){ let msgs=0, first=null, lastA=null, firstU=null; const st=[root];
  while(st.length){ const n=st.pop(); if(n.kind==="text"){ msgs++; if(!first||n.line<first.line)first=n; if(n.role==="user"&&(!firstU||n.line<firstU.line))firstU=n; if(n.role==="assistant"&&(!lastA||n.line>lastA.line))lastA=n; } n.children.forEach(c=>st.push(c)); }
  return { msgs, first, firstU, lastA }; }

const forkMeta = new Map(); let forkIdx = 0;
(function assign(start){ altsInPath(pathFrom(start)).forEach(({anchor,alt})=>{
  if(!forkMeta.has(alt.id)){ const st=subtreeStats(alt);
    forkMeta.set(alt.id,{ name:"Fork "+String.fromCharCode(65+forkIdx), color:FORK_COLORS[forkIdx%FORK_COLORS.length], anchor, alt, st,
      label:(st.firstU||st.first||{text:"(tool step)"}).text }); forkIdx++; assign(alt); } }); })(ROOT);

/* ---------- helpers ---------- */
function inline(e){ return e.replace(/`([^`\n]+)`/g,'<code class="ic">$1</code>').replace(/\*\*([^*\n]+)\*\*/g,"<b>$1</b>").replace(/\[Image[^\]\n]*\]/g,'<span class="img-chip" title="세션 당시 붙여넣은 이미지 — 픽셀은 로그에 저장되지 않습니다">🖼 이미지 첨부</span>'); }

/* highlight.js (Catppuccin 팔레트는 CSS에서 hljs 토큰 클래스로 매핑) */
function hi(code, lang){
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    return esc(code);
  } catch { return esc(code); }
}
function hiLine(line, lang){
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
    return esc(line);
  } catch { return esc(line); }
}
function rich(raw){
  const parts=String(raw??"").split("```");
  if(parts.length===1) return inline(esc(parts[0]));
  let out="";
  parts.forEach((p,i)=>{
    if(i%2===1){
      let code=p, lang="", file="";
      const nl=code.indexOf("\n");
      if(nl>=0){
        const head=code.slice(0,nl).trim();
        const m=head.match(/^(\w+)(?::(.+))?$/);
        if(m){ lang=m[1]; file=m[2]||""; code=code.slice(nl+1); }
      }
      code=code.replace(/\n$/,"");
      const lines=code.split("\n").length;
      out+=`<span class="cb-wrap" data-lang="${esc(lang)}" data-file="${esc(file)}" data-code="${esc(code)}"><span class="cb">${hi(code, lang)}</span><span class="cb-fade"></span><span class="cb-fade-r"></span><span class="cb-chip">${file?esc(file)+" · ":""}${lines}줄 · 클릭하여 열기</span></span>`;
    } else {
      let t=p; if(i>0)t=t.replace(/^\n/,""); if(i<parts.length-1)t=t.replace(/\n$/,"");
      out+=inline(esc(t));
    }
  });
  return out;
}

/* ---------- state ---------- */
const panelsEl = document.getElementById("panels");
/* 줌 래퍼: CSS zoom은 레이아웃에 반영되어 스크롤 지오메트리가 시각 좌표와 일치 */
const canvasEl = document.createElement("div");
canvasEl.id = "zoomWrap";
canvasEl.style.cssText = "display:flex; align-items:stretch; width:max-content; min-width:100%; height:100%; position:relative;";
panelsEl.appendChild(canvasEl);
let ZOOM = 1;
function setZoom(z, cx, cy){
  z = Math.max(0.5, Math.min(1.5, z));
  if (z === ZOOM) return;
  const pr = panelsEl.getBoundingClientRect();
  const ox = cx !== undefined ? cx - pr.left : panelsEl.clientWidth / 2;
  const oy = cy !== undefined ? cy - pr.top : panelsEl.clientHeight / 2;
  const r = z / ZOOM;
  const sl = (panelsEl.scrollLeft + ox) * r - ox;
  const st = (panelsEl.scrollTop + oy) * r - oy;
  ZOOM = z;
  canvasEl.style.zoom = z;
  const pb = panelsEl.style.scrollBehavior; panelsEl.style.scrollBehavior = "auto";
  panelsEl.scrollLeft = sl; panelsEl.scrollTop = st;
  panelsEl.style.scrollBehavior = pb;
  refreshBars(); requestAnimationFrame(updateOverview);
}
let openPath = [];
let panels = [];
let focusDepth = 0;
let codeCol = null;   // {el, srcPanel, srcDepth, tabs:[{wrap,file,lang,code}], active}

/* ---------- DOM 커스텀 스크롤바 ---------- */
const barUpdaters=[];
function attachScrollbar(scrollEl, host, axis, extraClass){
  const bar=document.createElement("div");
  bar.className="sb sb-"+axis+(extraClass?" "+extraClass:"");
  const thumb=document.createElement("div"); thumb.className="sb-thumb";
  bar.appendChild(thumb); host.appendChild(bar);
  const Y=axis==="y";
  const vis=()=>Y?scrollEl.clientHeight:scrollEl.clientWidth;
  const tot=()=>Y?scrollEl.scrollHeight:scrollEl.scrollWidth;
  const pos=()=>Y?scrollEl.scrollTop:scrollEl.scrollLeft;
  function update(){
    if(!document.contains(bar)) return;
    const v=vis(), t=tot();
    if(t<=v+2){ bar.style.display="none"; return; }
    bar.style.display="";
    const trackLen=Y?bar.clientHeight:bar.clientWidth;
    const len=Math.max(Y?26:36, trackLen*v/t);
    const off=(trackLen-len)*(pos()/(t-v)||0);
    if(Y){ thumb.style.height=len+"px"; thumb.style.transform=`translateY(${off}px)`; }
    else { thumb.style.width=len+"px"; thumb.style.transform=`translateX(${off}px)`; }
  }
  scrollEl.addEventListener("scroll",()=>requestAnimationFrame(update));
  new ResizeObserver(()=>requestAnimationFrame(update)).observe(scrollEl);
  if(scrollEl.firstElementChild) new ResizeObserver(()=>requestAnimationFrame(update)).observe(scrollEl.firstElementChild);
  let drag=null;
  thumb.addEventListener("pointerdown",e=>{
    e.preventDefault(); e.stopPropagation();
    thumb.setPointerCapture(e.pointerId);
    drag={start:Y?e.clientY:e.clientX, orig:pos(), prevBehavior:scrollEl.style.scrollBehavior};
    scrollEl.style.scrollBehavior="auto"; bar.classList.add("drag");
  });
  thumb.addEventListener("pointermove",e=>{
    if(!drag) return;
    const v=vis(), t=tot();
    const trackLen=Y?bar.clientHeight:bar.clientWidth;
    const len=Math.max(Y?26:36, trackLen*v/t);
    const d=(Y?e.clientY:e.clientX)-drag.start;
    const val=drag.orig + d*(t-v)/Math.max(1,trackLen-len);
    if(Y) scrollEl.scrollTop=val; else scrollEl.scrollLeft=val;
  });
  thumb.addEventListener("pointerup",()=>{ if(drag){ scrollEl.style.scrollBehavior=drag.prevBehavior; } drag=null; bar.classList.remove("drag"); });
  /* 트랙 빈 곳 클릭 → 해당 위치로 부드럽게 이동 */
  bar.addEventListener("pointerdown",e=>{
    if(e.target!==bar) return;
    const r=bar.getBoundingClientRect();
    const frac=Y?(e.clientY-r.top)/r.height:(e.clientX-r.left)/r.width;
    const v=vis(), t=tot();
    scrollEl.scrollTo(Y?{top:frac*t-v/2, behavior:"smooth"}:{left:frac*t-v/2, behavior:"smooth"});
  });
  barUpdaters.push(update);
  requestAnimationFrame(update);
}
function refreshBars(){ barUpdaters.forEach(u=>u()); if(typeof updateOverview==='function') try{ updateOverview(); }catch(e){} }

function buildAcc(label, items, isThink){
  const acc=document.createElement("div"); acc.className="acc";
  acc.innerHTML=`<button class="acc-head">${label} <span class="chev">\u25b8</span></button>
    <div class="acc-body"></div>`;
  let rendered=false;
  acc.querySelector(".acc-head").addEventListener("click",()=>{
    if(!rendered){ /* 대형 세션 대비: 본문은 첫 펼침 때만 렌더 */
      rendered=true;
      acc.querySelector(".acc-body").innerHTML=items.map(t=>`<div class="${isThink?"think":"step"}">${esc(t||"(요약 없음)")}</div>`).join("");
    }
    acc.classList.toggle("open");
    requestAnimationFrame(layoutRails);
  });
  return acc;
}
function makePanel(startNode, depth){
  const isMain = depth===0;
  const meta = isMain ? null : forkMeta.get(startNode.id);
  const path = pathFrom(startNode);
  const alts = altsInPath(path);
  const color = isMain ? "var(--main)" : meta.color;

  const panel=document.createElement("div");
  panel.className="panel"+(isMain?"":" branch")+(alts.length?" has-rail":"");
  panel.style.setProperty("--pc", color);
  const name  = isMain ? "main" : meta.name+" — abandoned";
  const stats = isMain ? path.filter(n=>n.kind==="text").length+" msgs · "+fmtSpan(meta0.first_ts, meta0.last_ts)
                       : meta.st.msgs+" msgs · "+meta.anchor.hm+" 분기";
  panel.innerHTML=`
    <div class="panel-hd">
      <span class="dot"></span>
      <span class="ph-name" style="${isMain?"":"color:"+color}">${name}</span>
      <span class="ph-meta">${stats}</span>
      <span class="spacer"></span>
      ${isMain?"":`<button class="switch-mini">이 분기로 전환 →</button><button class="close" title="컬럼 닫기">✕</button>`}
    </div>
    <div class="panel-scroll"><div class="thread"></div>${alts.length?'<div class="rail"></div>':""}</div>`;

  if(!isMain) panel.querySelector(".close").addEventListener("click",e=>{ e.stopPropagation(); closeFrom(depth); });
  panel._group = isMain ? "main" : startNode.id;
  panel._gcolor = isMain ? "#3987e5" : meta.color;
  panel.addEventListener("pointerdown",()=>{ bringFront(panel); setActiveGroup(panel._group, panel._gcolor); });
  panel.addEventListener("click",()=>setFocus(panels.indexOf(panel)));
  const scroller=panel.querySelector(".panel-scroll");

  const thread=panel.querySelector(".thread");
  const rail=panel.querySelector(".rail");
  if(isMain){
    const intro=document.createElement("div"); intro.className="thread-intro";
    intro.innerHTML=`<b>episodic memory</b> · 여백 카드를 클릭하면 분기가 앵커 응답에서 이어지는 컬럼으로 열립니다`;
    thread.appendChild(intro);
  }

  const railCards=[]; const anchorRows=new Map(); const cardsByAlt=new Map(); const rowByNode=new Map();
  let tools=[], toolIds=[], thinks=[], thinkIds=[], lastRow=null;
  const flush=()=>{ if(tools.length){ const acc=buildAcc(`🔧 ${tools.length} tool step${tools.length>1?"s":""}`, tools, false); thread.appendChild(acc); toolIds.forEach(id=>rowByNode.set(id,acc)); tools=[]; toolIds=[]; }
                    if(thinks.length){ const acc=buildAcc(`🧠 사고 과정 · ${thinks.join("").length}자`, thinks, true); thread.appendChild(acc); thinkIds.forEach(id=>rowByNode.set(id,acc)); thinks=[]; thinkIds=[]; } };
  path.forEach(n=>{
    if(n.kind==="tool"){ tools.push(n.text); toolIds.push(n.id); }
    else if(n.kind==="think"){ thinks.push(n.text); thinkIds.push(n.id); }
    else if(n.kind==="choice"){
      flush();
      const parsed=parseChoice(n.text, nextToolResultText(n));
      const card=document.createElement("div");
      card.className="choice-card";
      card.innerHTML=`<div class="ch-q">${esc(parsed.q)}</div>`+parsed.opts.map(o=>`<div class="ch-opt${o.sel?" sel":""}">${esc(o.label)}</div>`).join("");
      thread.appendChild(card);
    }
    else if(n.kind==="plan"){
      flush();
      const { title: ptitle, body: pbody } = parsePlan(n.text);
      const card=document.createElement("button");
      card.className="plan-card";
      card.innerHTML=`<span class="plan-ico">${DOC_SVG}</span><div class="plan-title">${esc(ptitle)}<span class="tag">PLAN</span></div><div class="plan-body">${esc(pbody)}</div><div class="plan-more">전체 보기 → (창으로 열림)</div>`;
      card.addEventListener("click",e=>{ e.stopPropagation(); singleton("plan:"+n.id, ()=>createDocFloat(ptitle, pbody, panel)); });
      thread.appendChild(card); rowByNode.set(n.id,card);
    }
    else {
      flush();
      const row=document.createElement("div");
      row.className="msg-row "+(n.role==="user"?"user":"asst");
      row.dataset.nid=n.id;
      row.innerHTML=`<div class="bubble"><div class="body">${rich(n.text)}</div>
        <div class="msg-meta">${n.role==="user"?"사용자":"Claude"} · ${n.hm}</div></div>`;
      thread.appendChild(row); lastRow=row; rowByNode.set(n.id,row);
      if(n.children.length>1) anchorRows.set(n.id,row);
    }
  });
  flush();

  alts.forEach(({anchor,alt})=>{
    const fm=forkMeta.get(alt.id);
    const row=anchorRows.get(anchor.id)||lastRow;
    if(row && !row.querySelector(".fork-dot")){
      const d=document.createElement("span"); d.className="fork-dot"; d.style.background=fm.color;
      row.querySelector(".bubble").appendChild(d);
    }
    const card=document.createElement("button");
    card.className="rc"; card.style.setProperty("--rc-color",fm.color); card._altId=alt.id;
    const q=fm.st.firstU||fm.st.first;
    const nested=altsInPath(pathFrom(alt)).length;
    card.innerHTML=`
      <span class="rc-conn"></span>
      <div class="rc-head"><span class="rc-name">⑂ ${fm.name} · abandoned</span><span class="rc-time">${q?q.hm:""} 분기</span></div>
      <div class="rc-quote"><span class="q-role">사용자</span>${esc(q?q.text:"")}</div>
      ${fm.st.lastA?`<div class="rc-concl">결론 — ${esc(fm.st.lastA.text.split("\n")[0])}</div>`:""}
      <div class="rc-foot"><span>msgs <b>${fm.st.msgs}</b></span>${nested?`<span>중첩 분기 <b>${nested}</b></span>`:""}<span class="rc-openlbl">전체 보기 →</span></div>`;
    card.addEventListener("click",e=>{ e.stopPropagation(); openBranch(panels.indexOf(panel), alt.id); });
    rail.appendChild(card);
    railCards.push({card,row});
    cardsByAlt.set(alt.id,card);
  });
  panel._railCards=railCards;
  panel._rowByNode=rowByNode;
  panel._anchorRows=anchorRows;
  panel._cardsByAlt=cardsByAlt;
  panel._scroller=scroller;
  panel._openVis={};
  attachScrollbar(scroller, panel, "y");
  bindHeaderCopyDrag(panel);
  requestAnimationFrame(()=>initCodeBlocks(panel));
  return panel;
}

/* ---------- code blocks ---------- */
function initCodeBlocks(panel){
  panel.querySelectorAll(".cb-wrap:not([data-init])").forEach(wrap=>{
    wrap.dataset.init="1";
    const cb=wrap.querySelector(".cb");
    const hOver=cb.scrollHeight>150;
    const wOver=cb.scrollWidth>cb.clientWidth+6;
    if(hOver||wOver){
      wrap.classList.add("collapsible");
      if(wOver) wrap.classList.add("w-over");
      if(!hOver && cb.scrollHeight<64) wrap.classList.add("slim");
      wrap.style.setProperty("--ch", hOver ? "132px" : (cb.scrollHeight+2)+"px");
    } else {
      wrap.classList.add("simple");
      wrap.style.setProperty("--ch",(cb.scrollHeight+2)+"px");
    }
    let dx=0,dy=0;
    wrap.addEventListener("pointerdown",e=>{ dx=e.clientX; dy=e.clientY; });
    wrap.addEventListener("click",e=>{
      e.stopPropagation();
      if(Math.hypot(e.clientX-dx,e.clientY-dy)>6) return;        /* 드래그 선택(일부 복사) → 열지 않음 */
      if(String(getSelection()).length) return;
      toggleFlowCode(wrap, panel);
    });
    const grab=document.createElement("span");
    grab.className="cb-grab"; grab.title="드래그하여 창으로 추출";
    wrap.appendChild(grab);
    bindGrabDrag(grab, ()=>wrap);
    if(wrap.classList.contains("collapsible")){
      wrap.addEventListener("mouseenter",()=>showPop(wrap, panel));
      wrap.addEventListener("mouseleave",e=>{
        if(pop && e.relatedTarget && (e.relatedTarget===pop || pop.contains(e.relatedTarget))) return;
        if(popWrap===wrap) hidePop();
      });
    }
  });
  layoutRails();
}

/* ---------- 연관 그룹 강조 ---------- */
let activeGroup="main", activeColor="#3987e5";
function setActiveGroup(key, color){
  if(key===undefined) key="main";
  activeGroup=key; activeColor=color||"#3987e5";
  [...panelsEl.querySelectorAll(".panel")].forEach(el=>{
    const match = el._group===key;
    el.classList.toggle("related", match);
    if(match) el.style.setProperty("--gc", el._gcolor||activeColor);
  });
  renderTree();
  updateOverview();
}

/* ---------- z-order: 핀 창은 항상 위 티어 ---------- */
let zFloat=100, zPin=1000, frontEl=null;
function setFront(el){ if(frontEl===el) return; if(frontEl) frontEl.classList.remove("front"); frontEl=el; if(el) el.classList.add("front"); }
function bringFront(el){ el.style.zIndex = el._pinned ? ++zPin : ++zFloat; setFront(el); }

function makeDraggable(el, handle, onDrop){
  handle.addEventListener("pointerdown",e=>{
    if(e.target.closest("button")) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    bringFront(el);
    const sx=e.clientX, sy=e.clientY, ol=parseFloat(el.style.left)||0, ot=parseFloat(el.style.top)||0;
    el.classList.add("dragging");
    const mv=ev=>{ const L=ol+(ev.clientX-sx)/ZOOM, T=ot+(ev.clientY-sy)/ZOOM; el.style.left=L+"px"; el.style.top=T+"px"; ensureCanvas(L+el.offsetWidth, T+el.offsetHeight); requestAnimationFrame(updateOverview); };
    const up=()=>{ handle.removeEventListener("pointermove",mv); handle.removeEventListener("pointerup",up); el.classList.remove("dragging"); if(onDrop) onDrop(); };
    handle.addEventListener("pointermove",mv);
    handle.addEventListener("pointerup",up);
  });
}
const PIN_SVG='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6M12 4v6M8.5 10h7l2 4.5H6.5zM12 14.5V21"/></svg>';
function addPin(win, hd, beforeEl){
  const b=document.createElement("button");
  b.className="pinbtn"; b.title="항상 위에 고정 (토글)"; b.innerHTML=PIN_SVG;
  b.addEventListener("click",e=>{ e.stopPropagation(); win._pinned=!win._pinned; b.classList.toggle("on",win._pinned); bringFront(win); });
  hd.insertBefore(b, beforeEl);
}
function addResize(el){
  const g=document.createElement("span"); g.className="rz"; g.title="크기 조절";
  g.addEventListener("pointerdown",e=>{
    e.preventDefault(); e.stopPropagation();
    g.setPointerCapture(e.pointerId);
    const sx=e.clientX, sy=e.clientY, ow=el.offsetWidth, oh=el.offsetHeight;
    const mv=ev=>{ el.style.width=Math.max(280, ow+(ev.clientX-sx)/ZOOM)+"px"; el.style.height=Math.max(160, oh+(ev.clientY-sy)/ZOOM)+"px"; el._userSized=true; requestAnimationFrame(updateOverview); };
    const up=()=>{ g.removeEventListener("pointermove",mv); g.removeEventListener("pointerup",up); };
    g.addEventListener("pointermove",mv); g.addEventListener("pointerup",up);
  });
  el.appendChild(g);
}

/* ---------- 흐름 코드 컬럼: 좌우분할 · 원본은 하나만 ---------- */
let flowCode=null;   // {el, srcPanel, wrap}
function toggleFlowCode(wrap, srcPanel){
  if(flowCode && flowCode.wrap===wrap){ const s=flowCode.srcPanel; closeFlowCode(); setFocus(panels.indexOf(s)); return; }
  closeFlowCode();   // 다른 블록 클릭 → 기존 원본 닫힘
  const file=wrap.dataset.file||"(스니펫)", lang=wrap.dataset.lang, code=wrap.dataset.code;
  const el=document.createElement("div");
  el.className="panel code entering";
  el.style.setProperty("--pc","#8b7ee8");
  el.innerHTML=`<div class="code-hd"><span class="mac"><i></i><i></i><i></i></span><span class="code-file">${esc(file)}</span>${lang?`<span class="code-lang">${esc(lang)}</span>`:""}<button class="copy">복사</button><button class="close">✕</button></div>
    <div class="code-body">${code.split("\n").map((l,i)=>`<div class="cl"><span class="ln">${i+1}</span><span class="lc">${hiLine(l, lang)||" "}</span></div>`).join("")}</div>`;
  el.querySelector(".copy").addEventListener("click",e=>{ e.stopPropagation(); const b2=e.currentTarget;
    (navigator.clipboard?navigator.clipboard.writeText(code):Promise.reject()).catch(()=>{}).finally(()=>{ b2.textContent="복사됨 ✓"; setTimeout(()=>b2.textContent="복사",1400); }); });
  el.querySelector(".close").addEventListener("click",e=>{ e.stopPropagation(); const s=srcPanel; closeFlowCode(); setFocus(panels.indexOf(s)); });
  el._group=srcPanel._group; el._gcolor=srcPanel._gcolor;
  el.addEventListener("click",()=>{ splitFocus(srcPanel, el); });
  el.addEventListener("pointerdown",()=>{ bringFront(el); setActiveGroup(el._group, el._gcolor); });
  const wb=document.createElement("button"); wb.className="wrapbtn"; wb.title="자동 줄바꿈 토글"; wb.textContent="⤶";
  el.querySelector(".code-hd").insertBefore(wb, el.querySelector(".copy"));
  wb.addEventListener("click",e=>{ e.stopPropagation(); const on=el.querySelector(".code-body").classList.toggle("wrap"); wb.classList.toggle("on",on); });
  /* 흐름 코드 컬럼도 헤더 드래그로 창 추출 (원본은 내려놓는 순간 재생성) */
  bindDetachDrag(el, el.querySelector(".code-hd"), ()=>createCodeFloat([tabOfWrap(wrap)], 0, 0));
  srcPanel.after(el);   // 클릭한 컬럼 바로 우측
  attachScrollbar(el.querySelector(".code-body"), el, "y");
  attachScrollbar(el.querySelector(".code-body"), el, "x", "sb-codex");
  el.style.setProperty("--dock", dockValueFor(wrap).toFixed(0)+"px");
  flowCode={el, srcPanel, wrap};
  const cb=wrap.querySelector(".cb"); if(cb) cb.classList.add("tab-open");
  requestAnimationFrame(()=>splitFocus(srcPanel, el));
}
function closeFlowCode(){
  if(!flowCode) return;
  const cb=flowCode.wrap.querySelector(".cb"); if(cb) cb.classList.remove("tab-open");
  flowCode.el.remove(); flowCode=null;
}

/* ---------- 떠 있는 코드 창: B안 탭 · 겹치면 병합 ---------- */
const DOC_SVG='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7"/></svg>';
function createDocFloat(title, body, srcPanel){
  const win=document.createElement("div");
  win.className="panel code codewin docwin entering";
  win.style.setProperty("--pc","#3987e5");
  win.style.width="460px";
  win._pinned=false;
  win._group=(srcPanel&&srcPanel._group)||"main"; win._gcolor=(srcPanel&&srcPanel._gcolor)||"#3987e5";
  win.innerHTML=`<div class="code-hd"><span style="color:var(--main);display:inline-flex">${DOC_SVG}</span><span class="code-file">${esc(title)}</span><span class="code-lang">PLAN</span><span class="spacer" style="flex:1"></span><button class="pinbtn" title="항상 위에 고정">${PIN_SVG}</button><button class="copy">복사</button><button class="close">✕</button></div><div class="code-body">${esc(body)}</div>`;
  win.querySelector(".pinbtn").addEventListener("click",e=>{ e.stopPropagation(); win._pinned=!win._pinned; e.currentTarget.classList.toggle("on",win._pinned); bringFront(win); });
  win.querySelector(".copy").addEventListener("click",e=>{ e.stopPropagation(); const b=e.currentTarget;
    (navigator.clipboard?navigator.clipboard.writeText(body):Promise.reject()).catch(()=>{}).finally(()=>{ b.textContent="복사됨 ✓"; setTimeout(()=>b.textContent="복사",1400); }); });
  win.querySelector(".close").addEventListener("click",e=>{ e.stopPropagation(); win.remove(); });
  win.addEventListener("pointerdown",()=>{ bringFront(win); setActiveGroup(win._group, win._gcolor); });
  win.style.left=((srcPanel?srcPanel.offsetLeft+srcPanel.offsetWidth:panelsEl.scrollLeft/ZOOM+300)+18)+"px";
  win.style.top=(panelsEl.scrollTop/ZOOM+150)+"px";
  win.style.height="380px";
  canvasEl.appendChild(win);
  makeDraggable(win, win.querySelector(".code-hd"));
  addResize(win);
  bringFront(win);
  requestAnimationFrame(updateOverview);
  return win;
}
function tabOfWrap(wrap){
  const host=wrap.closest(".panel");
  return {file:wrap.dataset.file||"(스니펫)", lang:wrap.dataset.lang, code:wrap.dataset.code,
    group:(host&&host._group)||"main", gcolor:(host&&host._gcolor)||"#3987e5"};
}
function createCodeFloat(tabs, left, top){
  const win=document.createElement("div");
  win.className="panel code codewin entering";
  win.style.setProperty("--pc","#8b7ee8");
  win.style.left=left+"px"; win.style.top=top+"px"; win.style.width="480px";
  win.innerHTML=`<div class="code-hd"><div class="code-tabs"></div><button class="wrapbtn" title="자동 줄바꿈 토글">⤶</button><button class="pinbtn" title="항상 위에 고정 (토글)">${PIN_SVG}</button><button class="copy">복사</button><button class="close">✕</button></div><div class="code-body"></div>`;
  win._tabs=tabs.slice(); win._active=win._tabs.length-1; win._pinned=false;
  win.querySelector(".pinbtn").addEventListener("click",e=>{ e.stopPropagation(); win._pinned=!win._pinned; e.currentTarget.classList.toggle("on",win._pinned); bringFront(win); });
  win.querySelector(".copy").addEventListener("click",e=>{ e.stopPropagation(); const b2=e.currentTarget, t=win._tabs[win._active];
    (navigator.clipboard?navigator.clipboard.writeText(t.code):Promise.reject()).catch(()=>{}).finally(()=>{ b2.textContent="복사됨 ✓"; setTimeout(()=>b2.textContent="복사",1400); }); });
  win.querySelector(".close").addEventListener("click",e=>{ e.stopPropagation(); win.remove(); });
  win.querySelector(".wrapbtn").addEventListener("click",e=>{ e.stopPropagation(); const on=win.querySelector(".code-body").classList.toggle("wrap"); e.currentTarget.classList.toggle("on",on); });
  win.addEventListener("pointerdown",()=>{ bringFront(win); const t=win._tabs[win._active]; if(t) setActiveGroup(t.group, t.gcolor); });
  makeDraggable(win, win.querySelector(".code-hd"), ()=>tryMergeCodeFloat(win));
  addResize(win);
  canvasEl.appendChild(win);
  attachScrollbar(win.querySelector(".code-body"), win, "y");
  attachScrollbar(win.querySelector(".code-body"), win, "x", "sb-codex");
  renderCodeFloat(win);
  bringFront(win);
  return win;
}
function renderCodeFloat(win){
  const tabsEl=win.querySelector(".code-tabs");
  tabsEl.innerHTML="";
  win._tabs.forEach((t,i)=>{
    const b=document.createElement("button");
    b.className="code-tab"+(i===win._active?" on":"");
    b.innerHTML=`${esc(t.file)}${t.lang?` <span style="opacity:.5">${esc(t.lang)}</span>`:""}<span class="tx" title="탭 닫기">✕</span>`;
    b.addEventListener("click",e=>{ e.stopPropagation(); if(b._moved){ b._moved=false; return; } win._active=i; renderCodeFloat(win); });
    /* 탭 드래그 → 병합 해제(창으로 분리) */
    b.addEventListener("pointerdown",e=>{
      if(e.target.closest(".tx")) return;
      const sx=e.clientX, sy=e.clientY, idx=i;
      let out=null;
      const mv=ev=>{
        if(!out && Math.hypot(ev.clientX-sx, ev.clientY-sy)>22){
          b._moved=true;
          const pr0=panelsEl.getBoundingClientRect();
          if(win._tabs.length<=1){ out=win; bringFront(win); out._dragOff={x:ev.clientX-(parseFloat(win.style.left)||0)-pr0.left+panelsEl.scrollLeft*0, y:0}; }
          else {
            const t2=win._tabs.splice(idx,1)[0];
            win._active=Math.min(win._active, win._tabs.length-1);
            renderCodeFloat(win);
            out=createCodeFloat([t2], (ev.clientX-pr0.left+panelsEl.scrollLeft)/ZOOM-100, (ev.clientY-pr0.top+panelsEl.scrollTop)/ZOOM-14);
            out.classList.add("dragging");
          }
        }
        if(out){
          const pr0=panelsEl.getBoundingClientRect();
          out.style.left=((ev.clientX-pr0.left+panelsEl.scrollLeft)/ZOOM-100)+"px";
          out.style.top=((ev.clientY-pr0.top+panelsEl.scrollTop)/ZOOM-14)+"px";
          requestAnimationFrame(updateOverview);
        }
      };
      const up=()=>{ document.removeEventListener("pointermove",mv); document.removeEventListener("pointerup",up);
        if(out){ out.classList.remove("dragging"); tryMergeCodeFloat(out); } };
      document.addEventListener("pointermove",mv);
      document.addEventListener("pointerup",up);
    });
    b.querySelector(".tx").addEventListener("click",e=>{ e.stopPropagation();
      win._tabs.splice(i,1);
      if(!win._tabs.length){ win.remove(); return; }
      win._active=Math.min(win._active, win._tabs.length-1);
      renderCodeFloat(win);
    });
    tabsEl.appendChild(b);
  });
  const t=win._tabs[win._active];
  win._group=t.group; win._gcolor=t.gcolor;
  const lines=t.code.split("\n");
  win.querySelector(".code-body").innerHTML=lines.map((l,i)=>`<div class="cl"><span class="ln">${i+1}</span><span class="lc">${hiLine(l, t.lang)||" "}</span></div>`).join("");
  if(!win._userSized) win.style.height=Math.min(panelsEl.clientHeight*0.66, 118+lines.length*19.7)+"px";
  requestAnimationFrame(updateOverview);
}
function tryMergeCodeFloat(win){
  if(!document.contains(win)) return;
  const r=win.getBoundingClientRect();
  /* 드래그한 창의 헤더 중심점이 대상 창 안에 들어갔을 때만 병합 (타이틀바 도킹) */
  const hx=r.left+r.width/2, hy=r.top+22;
  for(const o of [...panelsEl.querySelectorAll(".codewin")]){
    if(o===win) continue;
    const q=o.getBoundingClientRect();
    if(hx>=q.left && hx<=q.right && hy>=q.top && hy<=q.bottom){
      o._tabs.push(...win._tabs); o._active=o._tabs.length-1;
      renderCodeFloat(o); bringFront(o);
      win.remove();
      return;
    }
  }
}
/* 드래그 띠 → 창 추출 (블록·팝오버 공용) */
function bindGrabDrag(grabEl, wrapGetter){
  grabEl.addEventListener("pointerdown",e=>{
    e.preventDefault(); e.stopPropagation();
    const wrap=wrapGetter(); if(!wrap) return;
    grabEl.setPointerCapture(e.pointerId);
    const pr0=panelsEl.getBoundingClientRect();
    const sx0=e.clientX, sy0=e.clientY;
    let win=null;
    const mv=ev=>{
      const L=(ev.clientX-pr0.left+panelsEl.scrollLeft)/ZOOM-120;
      const T=(ev.clientY-pr0.top+panelsEl.scrollTop)/ZOOM-16;
      if(!win){
        if(Math.hypot(ev.clientX-sx0, ev.clientY-sy0)<14) return;   /* 데드존 */
        softHidePop(); win=createCodeFloat([tabOfWrap(wrap)], L, T); win.classList.add("dragging");
      }
      win.style.left=L+"px"; win.style.top=T+"px";
    };
    const up=()=>{ grabEl.removeEventListener("pointermove",mv); grabEl.removeEventListener("pointerup",up);
      hidePop(); if(win){ win.classList.remove("dragging"); tryMergeCodeFloat(win); } };
    grabEl.addEventListener("pointermove",mv);
    grabEl.addEventListener("pointerup",up);
  });
}

/* ---------- hover 확장 오버레이 ---------- */
let pop=null, popWrap=null, popPanel=null;
function showPop(wrap, panel){
  hidePop();
  const cb=wrap.querySelector(".cb");
  const r=cb.getBoundingClientRect();
  pop=document.createElement("div"); pop.className="cb-pop";
  pop.innerHTML=hi(wrap.dataset.code, wrap.dataset.lang);
  pop.style.left=r.left+"px"; pop.style.top=r.top+"px";
  pop.style.width=r.width+"px"; pop.style.maxHeight=r.height+"px";
  _bodyAppend(pop);
  popWrap=wrap; popPanel=panel;
  const cw=pop.scrollWidth+8, ch=pop.scrollHeight+8;
  requestAnimationFrame(()=>{
    if(!pop) return;
    pop.style.width=Math.min(window.innerWidth-r.left-28, cw)+"px";
    pop.style.maxHeight=Math.min(window.innerHeight*0.66, window.innerHeight-r.top-20, ch)+"px";
  });
  pop.addEventListener("mouseleave",hidePop);
  const pg=document.createElement("span");
  pg.className="cb-grab"; pg.title="드래그하여 창으로 추출";
  pop.appendChild(pg);
  bindGrabDrag(pg, ()=>popWrap);
  let px=0,py=0;
  pop.addEventListener("pointerdown",e=>{ px=e.clientX; py=e.clientY; });
  pop.addEventListener("click",e=>{
    if(Math.hypot(e.clientX-px,e.clientY-py)>6) return;          /* 드래그 선택 → 열지 않음 */
    if(String(getSelection()).length) return;
    const w=popWrap, p=popPanel; hidePop(); toggleFlowCode(w,p);
  });
}
function softHidePop(){ if(pop){ pop.style.opacity="0"; pop.style.pointerEvents="none"; } }
function hidePop(){ if(pop){ pop.remove(); pop=null; popWrap=null; popPanel=null; } }

/* ---------- open / close branch ---------- */
function attachOpenVis(parentPanel, altId){
  const fm=forkMeta.get(altId);
  const row=parentPanel._anchorRows.get(fm.anchor.id);
  const card=parentPanel._cardsByAlt.get(altId);
  parentPanel.classList.add("rail-open");
  let flare=null;
  if(row){
    row.classList.add("anchor-open");
    row.style.setProperty("--ac", fm.color);
    flare=document.createElement("span");
    flare.className="flare";
    flare.innerHTML=`<span class="flare-pill" title="클릭하면 분기 컬럼이 닫힙니다">⑂ ${fm.name} ✕</span><span class="flare-line"></span>`;
    row.appendChild(flare);
    flare.querySelector(".flare-pill").addEventListener("click",e=>{
      e.stopPropagation();
      const d=panels.indexOf(parentPanel)+1;
      if(d>0 && panels[d]) closeFrom(d);
    });
    const bubble=row.querySelector(".bubble");
    requestAnimationFrame(()=>{
      const left=bubble.offsetLeft+bubble.offsetWidth+10;
      flare.style.left=left+"px";
      flare.style.width=Math.max(48,(THREAD_W+RAIL_MIN-34)-left)+"px"; /* 접힌 rail 폭까지만 — 짧은 스텁 */
    });
  }
  /* 다른 분기는 미니 배지로 축소 */
  const badges=[];
  const rail=parentPanel.querySelector(".rail");
  (parentPanel._railCards||[]).forEach(({card:c,row:r})=>{
    if(c._altId===altId) return;
    const fm2=forkMeta.get(c._altId);
    const b=document.createElement("button");
    b.className="rail-badge"; b.title=fm2.name+" — "+fm2.label;
    b.style.borderColor=fm2.color; b.style.color=fm2.color;
    b.style.top=(parseInt(c.style.top)||r.offsetTop)+"px";
    b.textContent="⑂"+fm2.name.slice(-1);
    b.addEventListener("click",e=>{ e.stopPropagation(); openBranch(panels.indexOf(parentPanel), c._altId); });
    rail.appendChild(b); badges.push(b);
  });
  parentPanel._openVis[altId]={row, flare, card, badges};
  return row;
}
function detachOpenVis(parentPanel, altId){
  const v=parentPanel._openVis[altId]; if(!v) return;
  if(v.row) v.row.classList.remove("anchor-open");
  if(v.flare) v.flare.remove();
  (v.badges||[]).forEach(b=>b.remove());
  delete parentPanel._openVis[altId];
  if(!Object.keys(parentPanel._openVis).length) parentPanel.classList.remove("rail-open");
}

function dockValueFor(anchorEl){
  const pr=panelsEl.getBoundingClientRect(), r=anchorEl.getBoundingClientRect();
  const base=panels[0]?panels[0].offsetTop:0;   /* = --cv-top 실측값 */
  const contentY=(r.top-pr.top+panelsEl.scrollTop)/ZOOM;
  return Math.max(0, Math.min(contentY-base+10, panelsEl.clientHeight*0.42));
}
function dockPanel(el, anchorEl){
  el.style.setProperty("--dock", dockValueFor(anchorEl).toFixed(0)+"px");
}

function openBranch(depth, altId){
  if(openPath[depth]===altId){ setFocus(depth+1); return; }
  closeFlowCode();
  for(let i=openPath.length-1;i>=depth;i--) detachOpenVis(panels[i], openPath[i]);
  panels.slice(depth+1).forEach(p=>p.remove());
  panels=panels.slice(0,depth+1);
  openPath=openPath.slice(0,depth); openPath.push(altId);
  const parent=panels[depth];
  const row=attachOpenVis(parent, altId);
  const p=makePanel(nodes.get(altId), depth+1);
  p.classList.add("entering");
  canvasEl.appendChild(p); panels.push(p);
  if(row) dockPanel(p, row);   /* 열 때 1회 도킹 — 이후 스크롤은 독립 */
  requestAnimationFrame(()=>{ layoutRails(); setTimeout(()=>setFocus(depth+1), 60); });
}
function closeFrom(depth){
  if(flowCode && panels.indexOf(flowCode.srcPanel)>=depth) closeFlowCode();
  for(let i=openPath.length-1;i>=depth-1;i--) if(openPath[i]!==undefined) detachOpenVis(panels[i], openPath[i]);
  panels.slice(depth).forEach(p=>p.remove());
  panels=panels.slice(0,depth);
  openPath=openPath.slice(0,depth-1);
  setFocus(depth-1);
}
function openChain(chain){
  closeFlowCode();
  let common=0;
  while(common<chain.length && openPath[common]===chain[common]) common++;
  for(let i=openPath.length-1;i>=common;i--) detachOpenVis(panels[i], openPath[i]);
  panels.slice(common+1).forEach(p=>p.remove());
  panels=panels.slice(0,common+1);
  openPath=openPath.slice(0,common);
  for(let i=common;i<chain.length;i++){
    const parent=panels[i];
    const row=attachOpenVis(parent, chain[i]);
    openPath.push(chain[i]);
    const p=makePanel(nodes.get(chain[i]), i+1);
    if(i===chain.length-1) p.classList.add("entering");
    canvasEl.appendChild(p); panels.push(p);
    if(row) dockPanel(p, row);
  }
  requestAnimationFrame(()=>{ layoutRails(); setTimeout(()=>setFocus(chain.length), 60); });
}

/* ---------- focus ---------- */
function allPanelEls(){ return [...panelsEl.querySelectorAll(".panel:not(.codewin):not(.float-panel)")]; }
function applyFocusEls(els, scrollEls){
  scrollEls=scrollEls||els;
  allPanelEls().forEach(p=>p.classList.toggle("focused", els.includes(p)));
  renderTree();
  const left=Math.min(...scrollEls.map(e=>e.offsetLeft));
  const right=Math.max(...scrollEls.map(e=>e.offsetLeft+e.offsetWidth));
  const w=panelsEl.clientWidth;
  const target = (right-left > w-40) ? right - w + 24 : (left+right)/2 - w/2;
  panelsEl.scrollTo({ left:target, behavior:"smooth" });
}
function splitFocus(srcPanel, codeEl){
  focusDepth=Math.max(0, panels.indexOf(srcPanel));
  applyFocusEls([srcPanel, codeEl], [srcPanel, codeEl]);
}
function setFocus(depth){
  focusDepth=Math.max(0, Math.min(depth,panels.length-1));
  setFront(panels[focusDepth]);
  const scrollEls = focusDepth>0 ? [panels[focusDepth-1], panels[focusDepth]] : [panels[0]];
  applyFocusEls([panels[focusDepth]], scrollEls);
}


/* ---------- layout ---------- */
function layoutRails(){
  panels.forEach(panel=>{
    let lastBottom=0;
    (panel._railCards||[]).forEach(({card,row})=>{
      let top=row?row.offsetTop:20;
      if(lastBottom && top<lastBottom+10) top=lastBottom+10;
      card.style.top=top+"px"; lastBottom=top+card.offsetHeight;
    });
  });
  refreshBars();
}

/* ---------- sidebar tree ---------- */
const treeEl=document.getElementById("tree");
const treeSvg=document.getElementById("treeSvg");
function renderTree(){
  [...treeEl.querySelectorAll(".tree-row")].forEach(e=>e.remove());
  const items=[];
  items.push({depth:0,rawColor:"#3987e5",label:"main",meta:pathFrom(ROOT).filter(n=>n.kind==="text").length+" msgs · "+fmtSpan(meta0.first_ts, meta0.last_ts),chain:[],
    active:focusDepth===0});
  (function walk(start, level, chain){
    altsInPath(pathFrom(start)).forEach(({anchor,alt})=>{
      const fm=forkMeta.get(alt.id);
      const myChain=chain.concat(alt.id);
      const isOpen=myChain.every((id,i)=>openPath[i]===id);
      items.push({depth:level,rawColor:fm.color,label:fm.label,meta:fm.name+" · "+fm.st.msgs+" msgs · "+anchor.hm+"에서 분기",
        chain:myChain, active:isOpen&&focusDepth===myChain.length});
      walk(alt, level+1, myChain);
    });
  })(ROOT,1,[]);

  const rows=[];
  items.forEach(it=>{
    const el=document.createElement("button");
    const relKey = it.chain.length ? it.chain[it.chain.length-1] : "main";
    el.className="tree-row"+(it.active?" active":"")+(relKey===activeGroup?" related":"");
    el.style.setProperty("--gc", it.rawColor);
    el.innerHTML=`<span class="tr-graph"></span><span class="tr-body"><span class="ti-label">${esc(it.label)}</span><span class="ti-meta">${esc(it.meta)}</span></span>`;
    el.addEventListener("click",()=>{ it.chain.length?openChain(it.chain):setFocus(0); });
    treeEl.appendChild(el); rows.push({el,it});
  });

  requestAnimationFrame(()=>{
    const H=treeEl.scrollHeight;
    treeSvg.setAttribute("width",54); treeSvg.setAttribute("height",H);
    treeSvg.style.height=H+"px";
    const X=d=>14+d*13;
    const pos=rows.map(({el,it})=>({x:X(it.depth), y:el.offsetTop+15, it}));
    pos.forEach(p=>{ p.it.chain=p.it.chain||[]; });
    let svg="";
    if(pos.length>1) svg+=`<line x1="${pos[0].x}" y1="${pos[0].y+7}" x2="${pos[0].x}" y2="${pos[pos.length-1].y}" stroke="#3987e5" stroke-width="2" opacity="0.35"/>`;
    const lastAtDepth={0:pos[0]};
    pos.slice(1).forEach(p=>{
      const parent=lastAtDepth[p.it.depth-1]||pos[0];
      const rel=(p.it.chain&&p.it.chain.length?p.it.chain[p.it.chain.length-1]:"main")===activeGroup;
      svg+=`<path d="M ${parent.x} ${parent.y+7} L ${parent.x} ${p.y-9} Q ${parent.x} ${p.y} ${p.x-5} ${p.y}" fill="none" stroke="${p.it.rawColor}" stroke-width="${rel?2.6:1.6}" opacity="${rel?1:0.6}"/>`;
      lastAtDepth[p.it.depth]=p;
    });
    pos.forEach(p=>{
      svg+=`<circle cx="${p.x}" cy="${p.y}" r="${p.it.active?5:4}" fill="${p.it.rawColor}"/>`;
      if(p.it.active) svg+=`<circle cx="${p.x}" cy="${p.y}" r="8" fill="none" stroke="${p.it.rawColor}" stroke-width="1.4" opacity="0.55"/>`;
    });
    treeSvg.innerHTML=svg;
  });
  renderCrumbs();
}

/* ---------- keyboard (13D: 키보드 퍼스트) ---------- */
document.addEventListener("keydown",(e)=>{
  /* 치트시트 열림 → 아무 키나 닫힘 */
  if(!cheatEl.hidden){ e.preventDefault(); hideCheat(); return; }
  /* ⌘K / Ctrl+K → 팔레트 토글 */
  if((e.metaKey||e.ctrlKey) && (e.key==="k"||e.key==="K")){ e.preventDefault(); palOpen()?closePalette():openPalette(); return; }
  /* 팔레트 열림: Esc가 기존 Esc 로직보다 우선 (그 외 키는 input 핸들러가 처리) */
  if(palOpen()){ if(e.key==="Escape") closePalette(); return; }
  const typing=e.target && e.target.closest && e.target.closest("input,textarea");
  if(e.key==="Escape"){
    hidePop();
    if(flowCode){ const sp=flowCode.srcPanel; closeFlowCode(); setFocus(panels.indexOf(sp)); }
    else if(openPath.length) closeFrom(openPath.length);
    return;
  }
  if(typing) return;
  if(e.key==="["){ e.preventDefault(); setFocus(focusDepth-1); }
  else if(e.key==="]"){ e.preventDefault(); setFocus(focusDepth+1); }
  else if(e.key==="?"){ e.preventDefault(); showCheat(); }
}, SIG);

/* ---------- 우측 상단 오버뷰 ---------- */
const ovEl=document.createElement("div");
ovEl.className="overview"; ovEl.title="오버뷰 — 클릭하면 그 위치로 이동";
ovEl.innerHTML='<div class="ov-vp"></div>';
_bodyAppend(ovEl);
function updateOverview(){
  const sw=panelsEl.scrollWidth, sh=panelsEl.scrollHeight;
  if(!sw||!sh) return;
  const k=Math.min(ovEl.clientWidth/sw, ovEl.clientHeight/sh);
  [...ovEl.querySelectorAll(".ov-item")].forEach(e=>e.remove());
  [...panelsEl.querySelectorAll(".panel, .anno")].forEach(el=>{
    const d=document.createElement("div");
    d.className="ov-item"+(el._group===activeGroup?" rel":"");
    d.style.cssText=`left:${el.offsetLeft*ZOOM*k}px;top:${el.offsetTop*ZOOM*k}px;width:${Math.max(3,el.offsetWidth*ZOOM*k)}px;height:${Math.max(3,el.offsetHeight*ZOOM*k)}px;background:${el._gcolor||"#8a8880"};`;
    ovEl.appendChild(d);
  });
  const vp=ovEl.querySelector(".ov-vp");
  vp.style.cssText=`left:${panelsEl.scrollLeft*k}px;top:${panelsEl.scrollTop*k}px;width:${panelsEl.clientWidth*k}px;height:${panelsEl.clientHeight*k}px;`;
}
ovEl.addEventListener("pointerdown",e=>{
  const r=ovEl.getBoundingClientRect();
  const k=Math.min(ovEl.clientWidth/panelsEl.scrollWidth, ovEl.clientHeight/panelsEl.scrollHeight);
  panelsEl.scrollTo({ left:(e.clientX-r.left)/k - panelsEl.clientWidth/2, top:(e.clientY-r.top)/k - panelsEl.clientHeight/2, behavior:"smooth" });
});
/* 도트 그리드를 팬(스크롤)에 동기화 — 콘텐츠와 함께 움직이는 것처럼 */
function syncGrid(){ panelsEl.style.backgroundPosition=(-panelsEl.scrollLeft)+"px "+(-panelsEl.scrollTop)+"px"; }
panelsEl.addEventListener("scroll",()=>{ syncGrid(); requestAnimationFrame(updateOverview); });

/* ---------- 캔버스 자동 확장 (draw.io식) ---------- */
function ensureCanvas(x, y){
  let ch=false;
  const w=canvasSpacer.offsetWidth, h=canvasSpacer.offsetHeight;
  if(x > w-420){ canvasSpacer.style.width=Math.max(w, x+900)+"px"; ch=true; }
  if(y > h-320){ canvasSpacer.style.height=Math.max(h, y+700)+"px"; ch=true; }
  if(ch) requestAnimationFrame(()=>{ refreshBars(); });
}
/* 휠로는 캔버스가 움직이지 않게 — 컬럼 내부 스크롤만 허용 */
panelsEl.addEventListener("wheel",e=>{
  const overPanel = e.target.closest && e.target.closest(".panel");
  if(e.ctrlKey || !overPanel){
    e.preventDefault();
    setZoom(ZOOM * (e.deltaY < 0 ? 1.09 : 0.917), e.clientX, e.clientY);
  }
},{passive:false});

/* ---------- 캔버스 팬: 빈 배경 클릭-드래그 ---------- */
panelsEl.addEventListener("pointerdown",e=>{
  if(e.target!==panelsEl && e.target!==canvasEl) return;
  panelsEl.setPointerCapture(e.pointerId);
  panelsEl.classList.add("panning");
  const sx=e.clientX, sy=e.clientY, sl=panelsEl.scrollLeft, st=panelsEl.scrollTop;
  const prevB=panelsEl.style.scrollBehavior;
  panelsEl.style.scrollBehavior="auto";
  const mv=ev=>{ panelsEl.scrollLeft=sl-(ev.clientX-sx); panelsEl.scrollTop=st-(ev.clientY-sy); };
  const up=()=>{ panelsEl.removeEventListener("pointermove",mv); panelsEl.removeEventListener("pointerup",up); panelsEl.classList.remove("panning"); panelsEl.style.scrollBehavior=prevB; };
  panelsEl.addEventListener("pointermove",mv);
  panelsEl.addEventListener("pointerup",up);
});

/* ---------- 컬럼 헤더 드래그 → 캔버스 사본 (원본은 흐름 유지) ---------- */
function floatCopyOf(panel){
  const clone=panel.cloneNode(true);
  clone.className="panel float-panel"+(panel.classList.contains("branch")?" branch":"")+(panel.classList.contains("has-rail")?" has-rail":"");
  const pc=getComputedStyle(panel).getPropertyValue("--pc");
  clone.style.cssText=""; clone.style.setProperty("--pc", pc);
  clone.querySelectorAll(".sb").forEach(x=>x.remove());
  clone.querySelectorAll(".flare").forEach(x=>x.remove());
  /* 사본은 원본과 절연: 접힘/앵커 상태 해제, 카드 전부 복원 */
  clone.querySelectorAll(".rail-badge").forEach(x=>x.remove());
  clone.querySelectorAll(".rc.hidden-open").forEach(x=>x.classList.remove("hidden-open"));
  clone.querySelectorAll(".msg-row.anchor-open").forEach(x=>x.classList.remove("anchor-open"));
  const r=panel.getBoundingClientRect();
  clone.style.width=r.width+"px";
  clone.style.height=Math.min(r.height, panelsEl.clientHeight-40)+"px";
  const hd=clone.querySelector(".panel-hd");
  const tag=document.createElement("span");
  tag.style.cssText="font-size:9.5px;color:var(--text-3);border:1px dashed var(--border);border-radius:5px;padding:1px 6px;white-space:nowrap";
  tag.textContent="사본";
  const sp=hd.querySelector(".spacer"); hd.insertBefore(tag, sp);
  let close=hd.querySelector(".close");
  if(close){ const f=close.cloneNode(true); close.replaceWith(f); close=f; }
  else { close=document.createElement("button"); close.className="close"; close.textContent="✕"; hd.appendChild(close); }
  close.addEventListener("click",e=>{ e.stopPropagation(); clone.remove(); });
  clone._pinned=false;
  clone._group=panel._group; clone._gcolor=panel._gcolor;
  addPin(clone, hd, close);
  addResize(clone);
  clone.addEventListener("pointerdown",()=>{ bringFront(clone); setActiveGroup(clone._group, clone._gcolor); });
  clone.querySelectorAll(".acc-head").forEach(h=>h.addEventListener("click",()=>h.parentElement.classList.toggle("open")));
  /* 사본 안 Fork 카드 → 사본 분기 창 (원본과 무관) */
  const srcCards=panel._railCards||[];
  [...clone.querySelectorAll(".rc")].forEach((c,i)=>{
    const alt=srcCards[i]&&srcCards[i].card._altId;
    const fresh=c.cloneNode(true); c.replaceWith(fresh);
    if(alt) fresh.addEventListener("click",e=>{ e.stopPropagation(); spawnFloatBranch(alt, clone); });
  });
  clone._railCards=null;
  /* 사본 안 코드블록 → 코드 창 / 그립 재바인딩 */
  [...clone.querySelectorAll(".cb-wrap")].forEach(w=>{
    const fresh=w.cloneNode(true); w.replaceWith(fresh);
    fresh.addEventListener("click",e=>{
      e.stopPropagation();
      if(String(getSelection()).length) return;
      createCodeFloat([tabOfWrap(fresh)], (parseFloat(clone.style.left)||0)+60, (parseFloat(clone.style.top)||0)+60);
    });
    const g=fresh.querySelector(".cb-grab");
    if(g) bindGrabDrag(g, ()=>fresh);
  });
  makeDraggable(clone, hd);
  return clone;
}
function bindDetachDrag(panelEl, hd, spawner, groupSpawner){
  hd.addEventListener("pointerdown",e=>{
    if(e.target.closest("button")) return;
    hd.setPointerCapture(e.pointerId);
    const sx=e.clientX, sy=e.clientY, withGroup=e.ctrlKey;
    let fls=[], hidden=[], offs=[];
    const mv=ev=>{
      if(!fls.length && Math.hypot(ev.clientX-sx, ev.clientY-sy)>26){
        const pr=panelsEl.getBoundingClientRect();
        const sources=(withGroup && groupSpawner) ? groupSpawner() : [{el:panelEl, make:spawner}];
        sources.forEach(({el,make})=>{
          const r=el.getBoundingClientRect();
          const ox=(r.left-pr.left+panelsEl.scrollLeft)/ZOOM, oy=(r.top-pr.top+panelsEl.scrollTop)/ZOOM;
          const f=make();
          if(!f.isConnected) canvasEl.appendChild(f);
          f.style.left=ox+"px"; f.style.top=oy+"px";
          bringFront(f);
          el.style.opacity="0"; el.style.pointerEvents="none";
          fls.push(f); hidden.push(el); offs.push([ox,oy]);
        });
      }
      if(fls.length){
        fls.forEach((f,i)=>{
          const L=offs[i][0]+(ev.clientX-sx)/ZOOM, T=offs[i][1]+(ev.clientY-sy)/ZOOM;
          f.style.left=L+"px"; f.style.top=T+"px";
          ensureCanvas(L+f.offsetWidth, T+f.offsetHeight);
        });
        requestAnimationFrame(updateOverview);
      }
    };
    let done=false;
    const restore=()=>{ hidden.forEach(h=>{ h.style.opacity=""; h.style.pointerEvents="";
        h.classList.remove("refade"); void h.offsetWidth; h.classList.add("refade"); }); };
    const up=()=>{
      if(done) return; done=true;
      hd.removeEventListener("pointermove",mv);
      ["pointerup","pointercancel","lostpointercapture"].forEach(t=>hd.removeEventListener(t,up));
      window.removeEventListener("pointerup",up,true);
      if(fls.length){
        fls.forEach(f=>{ if(f.classList.contains("codewin")) tryMergeCodeFloat(f); });
        restore();   /* 내려놓는 순간 — 빈 자리에 원본 재생성. 어떤 경로로 끝나도 반드시 복원 */
        requestAnimationFrame(updateOverview);
      }
    };
    hd.addEventListener("pointermove",mv);
    ["pointerup","pointercancel","lostpointercapture"].forEach(t=>hd.addEventListener(t,up));
    window.addEventListener("pointerup",up,true);
  });
}
function copySpawnerOf(panel){
  return ()=>{
    const clone=floatCopyOf(panel);
    canvasEl.appendChild(clone);
    clone.querySelector(".panel-scroll").scrollTop=panel.querySelector(".panel-scroll").scrollTop;
    attachScrollbar(clone.querySelector(".panel-scroll"), clone, "y");
    return clone;
  };
}
/* 사본에서 연 분기도 사본 (원본은 흐름에 하나뿐) */
function spawnFloatBranch(altId, nearEl){
  const src=makePanel(nodes.get(altId), 9999);
  const fl=floatCopyOf(src);           /* makePanel 산출물을 사본으로 변환 */
  src.remove();
  canvasEl.appendChild(fl);
  const base=nearEl?{L:(parseFloat(nearEl.style.left)||nearEl.offsetLeft)+40, T:(parseFloat(nearEl.style.top)||nearEl.offsetTop)+40}:{L:panelsEl.scrollLeft/ZOOM+240, T:panelsEl.scrollTop/ZOOM+140};
  fl.style.left=base.L+"px"; fl.style.top=base.T+"px";
  fl.style.height=Math.min(620, panelsEl.clientHeight-60)+"px";
  attachScrollbar(fl.querySelector(".panel-scroll"), fl, "y");
  bringFront(fl);
  ensureCanvas(base.L+fl.offsetWidth, base.T+fl.offsetHeight);
  requestAnimationFrame(updateOverview);
  return fl;
}
function bindHeaderCopyDrag(panel){
  bindDetachDrag(panel, panel.querySelector(".panel-hd"), copySpawnerOf(panel),
    ()=>{ /* Ctrl: 이 컬럼 + 열려 있는 하위 포크 컬럼까지 */
      const d=panels.indexOf(panel);
      const list=d>=0 ? panels.slice(d) : [panel];
      return list.map(el=>({el, make:copySpawnerOf(el)}));
    });
}

/* ---------- 주석·큐레이션 레이어 (메모 · 인용) ---------- */
const NOTE_COLORS=["#e0b13e","#3987e5","#199e70"];
const annoCountEl=document.getElementById("annoCount");
function updateAnnoCount(){ saveAnno();
  const n=panelsEl.querySelectorAll(".note-card").length;
  const q=panelsEl.querySelectorAll(".quote-card").length;
  annoCountEl.textContent=`메모 ${n} · 인용 ${q}`;
}
annoCountEl.addEventListener("click",()=>{
  panelsEl.querySelectorAll(".anno").forEach(el=>{
    el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse");
    setTimeout(()=>el.classList.remove("pulse"), 950);
  });
});
function setupAnno(el){
  el.addEventListener("pointerup",()=>saveAnno());
  el.addEventListener("input",()=>saveAnno());
  el._gcolor="#e0b13e";   /* 오버뷰: 앰버 사각형 */
  el.addEventListener("pointerdown",()=>bringFront(el));
  el.querySelector(".anno-x").addEventListener("click",e=>{ e.stopPropagation(); el.remove(); updateAnnoCount(); saveAnno(); requestAnimationFrame(updateOverview); });

  makeDraggable(el, el.querySelector(".anno-hd"));
  canvasEl.appendChild(el);
  bringFront(el);
  updateAnnoCount();
  requestAnimationFrame(updateOverview);
}
const ANNO_KEY = "sb-anno-" + (meta0.id || "unknown");
let annoSaveTimer = 0;
function saveAnno(){
  clearTimeout(annoSaveTimer);
  annoSaveTimer = window.setTimeout(()=>{
    const out=[];
    panelsEl.querySelectorAll(".note-card").forEach(el=>{
      out.push({t:"note", x:parseFloat(el.style.left)||0, y:parseFloat(el.style.top)||0,
        c:el.style.getPropertyValue("--nc")||"", text:(el.querySelector(".note-body")||{}).innerText||""});
    });
    panelsEl.querySelectorAll(".quote-card").forEach(el=>{
      out.push({t:"quote", x:parseFloat(el.style.left)||0, y:parseFloat(el.style.top)||0,
        text:el._qtext||"", mid:el._mid||"", who:el._who||""});
    });
    try { localStorage.setItem(ANNO_KEY, JSON.stringify(out)); } catch {}
  }, 350);
}
function loadAnno(){
  let arr=[]; try { arr=JSON.parse(localStorage.getItem(ANNO_KEY)||"[]"); } catch {}
  arr.forEach(a=>{
    if(a.t==="note"){
      const el=createNote(a.x, a.y);
      if(a.c) el.style.setProperty("--nc", a.c);
      const b=el.querySelector(".note-body"); if(b) b.innerText=a.text||"";
      const nb=el.querySelector(".note-body"); if(nb) nb.blur();
    } else if(a.t==="quote"){
      const src=a.mid?panelsEl.querySelector(`[data-nid="${a.mid}"]`):null;
      const el=createQuote(a.text||"", src, panels[0], a.who||"");
      el.style.left=(a.x||40)+"px"; el.style.top=(a.y||40)+"px";
    }
  });
  updateAnnoCount();
}
function createNote(x,y){
  const el=document.createElement("div");
  el.className="anno note-card";
  el.style.setProperty("--nc", NOTE_COLORS[0]);
  el.style.left=x+"px"; el.style.top=y+"px";
  el.innerHTML=`<div class="anno-hd"><span class="anno-tag">메모</span><span class="note-dots">${NOTE_COLORS.map(c=>`<button class="nd" data-c="${c}" style="background:${c}" title="색 변경"></button>`).join("")}</span><button class="anno-x" title="삭제">✕</button></div>
    <div class="note-body" contenteditable="true" data-ph="메모…"></div>`;
  el.querySelectorAll(".nd").forEach(d=>d.addEventListener("click",e=>{ e.stopPropagation(); el.style.setProperty("--nc", d.dataset.c); }));
  const body=el.querySelector(".note-body");
  body.addEventListener("keydown",e=>{ e.stopPropagation(); if(e.key==="Escape") body.blur(); });   /* 편집 중 Esc가 분기를 닫지 않게 */
  setupAnno(el);
  requestAnimationFrame(()=>body.focus());
  return el;
}
/* 빈 캔버스 더블클릭 → 그 위치에 스티키 메모 (target===panelsEl일 때만 — 팬과 충돌 없음) */
panelsEl.addEventListener("dblclick",e=>{
  if(e.target!==panelsEl && e.target!==canvasEl) return;
  const pr=panelsEl.getBoundingClientRect();
  const x=(e.clientX-pr.left+panelsEl.scrollLeft)/ZOOM-10;
  const y=(e.clientY-pr.top+panelsEl.scrollTop)/ZOOM-10;
  createNote(x,y);
  ensureCanvas(x+280, y+190);
});

/* --- 버블 텍스트 선택 → 인용 --- */
function createQuote(text, row, panel, whoOverride){
  const meta=row&&row.querySelector(".msg-meta");
  const who=whoOverride||(meta?meta.textContent.trim().split(" · ").slice(0,2).join(" · "):"");
  const pname=panel?(panel.querySelector(".ph-name")?panel.querySelector(".ph-name").textContent.split(" — ")[0]:"main"):"main";
  const qc=(panel&&panel._gcolor)||"#3987e5";
  const el=document.createElement("div");
  el.className="anno quote-card";
  el.style.setProperty("--qc", qc);
  el.innerHTML=`<div class="anno-hd"><span class="anno-tag" style="color:${qc}">📌 인용</span><button class="anno-x" title="삭제">✕</button></div>
    <div class="q-text">“${esc(text)}”</div>
    <div class="q-src">${esc(who)} · ${esc(pname)}</div>
    <button class="q-go">원문으로 →</button>`;
  el._qtext=text; el._who=who; el._mid=(row&&row.dataset&&row.dataset.nid)||"";
  el.querySelector(".q-go").addEventListener("click",e=>{
    e.stopPropagation();
    if(!row||!document.contains(row)){ e.currentTarget.textContent="원문 닫힘"; return; }
    const idx=panels.indexOf(panel);
    if(idx>=0) setFocus(idx);
    const sc=(panel&&panel._scroller)||row.closest(".panel-scroll");
    if(sc) sc.scrollTo({ top:row.offsetTop - sc.clientHeight/2 + row.offsetHeight/2, behavior:"smooth" });
    const bub=row.querySelector(".bubble");
    if(bub){ bub.classList.remove("flash"); void bub.offsetWidth; bub.classList.add("flash"); setTimeout(()=>bub.classList.remove("flash"), 1250); }
  });
  setupAnno(el);
  return el;
}
let qBtn=null, qSel=null;
function hideQuoteBtn(){ if(qBtn){ qBtn.remove(); qBtn=null; qSel=null; } }
document.addEventListener("pointerup",e=>{
  if(e.target && e.target.closest && e.target.closest(".quote-btn")) return;
  setTimeout(()=>{
    hideQuoteBtn();
    const sel=getSelection();
    const txt=String(sel).trim();
    if(!txt || !sel.rangeCount) return;
    const range=sel.getRangeAt(0);
    let node=range.commonAncestorContainer;
    if(node.nodeType===3) node=node.parentElement;
    if(!node || !node.closest) return;
    const bodyEl=node.closest(".bubble .body");
    if(!bodyEl) return;
    const row=bodyEl.closest(".msg-row");
    const panel=bodyEl.closest(".panel");
    if(!row || !panel) return;
    const r=range.getBoundingClientRect();
    if(!r.width && !r.height) return;
    qBtn=document.createElement("button");
    qBtn.className="quote-btn";
    qBtn.textContent="📌 인용";
    qBtn.style.left=Math.min(window.innerWidth-96, Math.max(8, r.left+r.width/2-34))+"px";
    qBtn.style.top=Math.max(48, r.top-36)+"px";
    qSel={ text:txt.slice(0,400), row, panel, rect:r };
    qBtn.addEventListener("click",ev=>{
      ev.stopPropagation();
      const s=qSel; hideQuoteBtn();
      getSelection().removeAllRanges();
      const pr=panelsEl.getBoundingClientRect();
      const x=Math.max(8, (s.rect.right-pr.left+panelsEl.scrollLeft)/ZOOM+26);
      const y=Math.max(8, (s.rect.top-pr.top+panelsEl.scrollTop)/ZOOM-8);
      const el=createQuote(s.text, s.row, s.panel);
      el.style.left=x+"px"; el.style.top=y+"px";
      ensureCanvas(x+310, y+210);
      requestAnimationFrame(updateOverview);
    });
    _bodyAppend(qBtn);
  },0);
}, SIG);
document.addEventListener("pointerdown",e=>{
  if(qBtn && !(e.target.closest && e.target.closest(".quote-btn"))) hideQuoteBtn();
}, { capture:true, signal:AC.signal });


/* ================= 13D: 커맨드 팔레트 + 브레드크럼 + 치트시트 ================= */
/* ---------- 노드 → 체인 (조상 중 forkMeta 키를 바깥→안 순으로) ---------- */
function chainOfNode(id){
  const chain=[]; let c=nodes.get(id);
  while(c){ if(forkMeta.has(c.id)) chain.unshift(c.id); c=c.p?nodes.get(c.p):null; }
  return chain;
}
function chipOfChain(chain){
  if(!chain.length) return {name:"main", color:"#3987e5"};
  const fm=forkMeta.get(chain[chain.length-1]);
  return {name:fm.name, color:fm.color};
}
function sameChain(chain){ return chain.length===openPath.length && chain.every((c,i)=>openPath[i]===c); }
function ensureChain(chain){ if(!sameChain(chain)) openChain(chain); else setFocus(chain.length); }
/* 메시지로 이동: 컬럼 열고 스크롤 + 1.2초 플래시 */
function gotoMessage(id){
  const chain=chainOfNode(id);
  ensureChain(chain);
  setTimeout(()=>{
    const panel=panels[chain.length]; if(!panel) return;
    const row=panel.querySelector(`[data-nid="${id}"]`); if(!row) return;
    const sc=panel._scroller;
    sc.scrollTo({ top:Math.max(0, row.offsetTop - sc.clientHeight/2 + row.offsetHeight/2), behavior:"smooth" });
    row.classList.remove("kflash"); void row.offsetWidth; row.classList.add("kflash");
    setTimeout(()=>row.classList.remove("kflash"), 1300);
  }, 200);
}
/* 파일로 이동: 해당 컬럼 열고 흐름 코드 컬럼 오픈 */
function gotoFile(file, nodeId){
  const chain=chainOfNode(nodeId);
  ensureChain(chain);
  setTimeout(()=>{
    const panel=panels[chain.length]; if(!panel) return;
    const wrap=[...panel.querySelectorAll(".cb-wrap")].find(w=>w.dataset.file===file);
    if(wrap && !(flowCode && flowCode.wrap===wrap)) toggleFlowCode(wrap, panel);
  }, 240);
}

/* ---------- 검색 인덱스 ---------- */
const PAL_ITEMS=[];
(function buildPaletteIndex(){
  const stripCode=t=>String(t).replace(/```[\s\S]*?```/g," 〔코드〕 ").replace(/\s+/g," ").trim();
  /* 1) 메시지 (main + 모든 분기) */
  nodes.forEach(n=>{
    if(n.kind!=="text") return;
    const chain=chainOfNode(n.id), chip=chipOfChain(chain);
    const label=stripCode(n.text);
    PAL_ITEMS.push({ icon:n.role==="user"?"👤":"✳", label, hm:n.hm, chip,
      search:(label+" "+chip.name+" "+n.hm).toLowerCase(), run:()=>gotoMessage(n.id) });
  });
  /* 2) 코드 파일명 */
  const files=new Map();
  nodes.forEach(n=>{
    const re=/```\w+:([^\n]+)/g; let m;
    while((m=re.exec(n.text))){ const f=m[1].trim(); if(!files.has(f)) files.set(f, n.id); }
  });
  files.forEach((nid,f)=>{
    PAL_ITEMS.push({ icon:"📄", label:f, hm:"", chip:{name:"파일",color:"#8b7ee8"},
      search:(f+" 파일 file code").toLowerCase(), run:()=>gotoFile(f, nid) });
  });
  /* 3) 포크 */
  forkMeta.forEach((fm,altId)=>{
    PAL_ITEMS.push({ icon:"⑂", label:fm.name+" — "+stripCode(fm.label), hm:fm.anchor.hm, chip:{name:fm.name,color:fm.color},
      search:(fm.name+" fork 포크 분기 "+fm.label).toLowerCase(), run:()=>ensureChain(chainOfNode(altId)) });
  });
  /* 4) 액션 */
  forkMeta.forEach((fm,altId)=>{
    PAL_ITEMS.push({ icon:"▸", label:fm.name+" 열기", hm:"", chip:{name:"액션",color:"#e0b13e"},
      search:(fm.name+" 열기 open 액션 action").toLowerCase(), run:()=>ensureChain(chainOfNode(altId)) });
  });
  files.forEach((nid,f)=>{
    PAL_ITEMS.push({ icon:"▸", label:"코드 창: "+f, hm:"", chip:{name:"액션",color:"#e0b13e"},
      search:("코드 창 "+f+" 액션 action open code").toLowerCase(), run:()=>gotoFile(f, nid) });
  });
  const plan=[...nodes.values()].find(n=>n.kind==="plan");
  if(plan){
    const parts=plan.text.split("|");
    PAL_ITEMS.push({ icon:"▸", label:"플랜 문서 열기 — "+parts[0], hm:plan.hm, chip:{name:"액션",color:"#e0b13e"},
      search:("플랜 문서 열기 plan "+parts[0]).toLowerCase(),
      run:()=>createDocFloat(parts[0], parts.slice(1).join("|"), panels[0]) });
  }
})();

/* ---------- 팔레트 DOM ---------- */
const palOverlay=document.createElement("div");
palOverlay.className="pal-overlay"; palOverlay.hidden=true;
palOverlay.innerHTML=`<div class="pal">
  <input class="pal-input" type="text" spellcheck="false" placeholder="메시지 · 파일 · 포크 · 액션 검색…">
  <div class="pal-list"></div>
  <div class="pal-hint"><span><b>↑↓</b> 이동</span><span><b>Enter</b> 실행</span><span><b>Esc</b> 닫기</span></div>
</div>`;
_bodyAppend(palOverlay);
const palInput=palOverlay.querySelector(".pal-input");
const palList=palOverlay.querySelector(".pal-list");
let palFiltered=[], palSel=0;
function markSnippet(label,q){
  const cap=(s,n)=>s.length>n?s.slice(0,n)+"…":s;
  if(!q) return esc(cap(label,90));
  const i=label.toLowerCase().indexOf(q);
  if(i<0) return esc(cap(label,90));
  const start=Math.max(0,i-28), end=Math.min(label.length, i+q.length+62);
  return esc((start>0?"…":"")+label.slice(start,i))
    +"<mark>"+esc(label.slice(i,i+q.length))+"</mark>"
    +esc(label.slice(i+q.length,end)+(end<label.length?"…":""));
}
function palRender(){
  const q=palInput.value.trim().toLowerCase();
  const annoItems=[...panelsEl.querySelectorAll(".note-card,.quote-card")].map(el=>{
    const isNote=el.classList.contains("note-card");
    const txt=(el.querySelector(isNote?".note-body":".q-text, .anno-body")||el).textContent.trim().replace(/\s+/g," ");
    return { icon:isNote?"🗒":"📌", label:txt||"(빈 메모)", search:(txt||"").toLowerCase(), hm:"",
      chip:{name:isNote?"메모":"인용", color:"#e0b13e"},
      run:()=>{ bringFront(el);
        panelsEl.scrollTo({left:el.offsetLeft*ZOOM-panelsEl.clientWidth/2, top:el.offsetTop*ZOOM-panelsEl.clientHeight/2, behavior:"smooth"});
        el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse"); setTimeout(()=>el.classList.remove("pulse"),950); } };
  });
  const ALL=PAL_ITEMS.concat(annoItems);
  palFiltered=ALL.filter(it=>!q || it.search.includes(q) || it.label.toLowerCase().includes(q));
  if(palSel>=palFiltered.length) palSel=Math.max(0,palFiltered.length-1);
  palList.innerHTML = palFiltered.length ? palFiltered.map((it,i)=>
    `<button class="pal-item${i===palSel?" sel":""}" data-i="${i}" style="--pc2:${it.chip.color}">
       <span class="pi-ico">${it.icon}</span>
       <span class="pi-main">${markSnippet(it.label,q)}</span>
       <span class="pi-chip">${esc(it.chip.name)}</span>
       ${it.hm?`<span class="pi-time">${it.hm}</span>`:""}
     </button>`).join("")
    : `<div class="pal-empty">“${esc(palInput.value)}” — 결과 없음</div>`;
  const sel=palList.querySelector(".sel");
  if(sel) sel.scrollIntoView({block:"nearest"});
}
function openPalette(){ hidePop(); document.getElementById("ckHint").classList.add("open"); palOverlay.hidden=false; palInput.value=""; palSel=0; palRender(); requestAnimationFrame(()=>palInput.focus()); }
function closePalette(){ document.getElementById("ckHint").classList.remove("open"); palOverlay.hidden=true; palInput.blur(); }
function palOpen(){ return !palOverlay.hidden; }
palOverlay.addEventListener("pointerdown",e=>{ if(e.target===palOverlay) closePalette(); });
palInput.addEventListener("input",()=>{ palSel=0; palRender(); });
palInput.addEventListener("keydown",e=>{
  if(e.key==="ArrowDown"){ e.preventDefault(); if(palFiltered.length){ palSel=(palSel+1)%palFiltered.length; palRender(); } }
  else if(e.key==="ArrowUp"){ e.preventDefault(); if(palFiltered.length){ palSel=(palSel-1+palFiltered.length)%palFiltered.length; palRender(); } }
  else if(e.key==="Enter"){ e.preventDefault(); e.stopPropagation(); const it=palFiltered[palSel]; closePalette(); if(it) it.run(); }
  else if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); closePalette(); }
});
palList.addEventListener("click",e=>{
  const b=e.target.closest(".pal-item"); if(!b) return;
  const it=palFiltered[+b.dataset.i]; closePalette(); if(it) it.run();
});
palList.addEventListener("pointermove",e=>{
  const b=e.target.closest(".pal-item"); if(!b || palSel===+b.dataset.i) return;
  palSel=+b.dataset.i;
  [...palList.querySelectorAll(".pal-item")].forEach(x=>x.classList.toggle("sel", +x.dataset.i===palSel));
});
document.getElementById("ckHint").addEventListener("click",openPalette);

/* ---------- 브레드크럼 바 ---------- */
const crumbsEl=document.getElementById("crumbs");
function renderCrumbs(){
  let html=`<button class="crumb${focusDepth===0?" on":""}" data-d="0" style="--cc:#3987e5">main</button>`;
  openPath.forEach((altId,i)=>{
    const fm=forkMeta.get(altId);
    html+=`<span class="crumb-sep">▸</span><button class="crumb${focusDepth===i+1?" on":""}" data-d="${i+1}" style="--cc:${fm.color}">⑂ ${esc(fm.name)}</button>`;
  });
  html+=`<span class="crumbs-note">열린 컬럼 체인 — 칩 클릭 시 해당 컬럼으로 포커스</span>`;
  crumbsEl.innerHTML=html;
  crumbsEl.querySelectorAll(".crumb").forEach(b=>b.addEventListener("click",()=>setFocus(+b.dataset.d)));
}

/* ---------- 단축키 치트시트 (? — 아무 키나 닫힘) ---------- */
const cheatEl=document.createElement("div");
cheatEl.className="cheat"; cheatEl.hidden=true; cheatEl.title="아무 키나 눌러 닫기";
cheatEl.innerHTML=`<h3>단축키</h3>
  <div class="ch-row"><span>커맨드 팔레트</span><span><kbd>⌘K</kbd> / <kbd>Ctrl K</kbd></span></div>
  <div class="ch-row"><span>이전 / 다음 컬럼 포커스</span><span><kbd>[</kbd> <kbd>]</kbd></span></div>
  <div class="ch-row"><span>팔레트 내 이동 · 실행</span><span><kbd>↑↓</kbd> <kbd>Enter</kbd></span></div>
  <div class="ch-row"><span>닫기 (팔레트 → 코드 → 분기)</span><span><kbd>Esc</kbd></span></div>
  <div class="ch-row"><span>이 치트시트</span><span><kbd>?</kbd></span></div>
  <div class="ch-foot">아무 키나 누르면 닫힙니다</div>`;
_bodyAppend(cheatEl);
function showCheat(){ closePalette(); hidePop(); cheatEl.hidden=false; }
function hideCheat(){ cheatEl.hidden=true; }
cheatEl.addEventListener("click",hideCheat);


/* ---------- init ---------- */
const canvasSpacer=document.createElement("div");
canvasSpacer.style.cssText="position:absolute;left:0;top:0;width:300vw;height:300vh;pointer-events:none;";
canvasEl.appendChild(canvasSpacer);
attachScrollbar(panelsEl, document.body, "x", "sb-panels");
attachScrollbar(panelsEl, document.body, "y", "sb-panels-y");
attachScrollbar(treeEl, document.querySelector(".sidebar"), "y");
panels=[makePanel(ROOT,0)];
canvasEl.appendChild(panels[0]);
requestAnimationFrame(()=>{
  layoutRails();
  panels[0]._scroller.scrollTop = panels[0]._scroller.scrollHeight;
  /* draw.io식: 첫 컬럼이 캔버스 정중앙 — 세로도 중앙 밴드로 스크롤 */
  const pb=panelsEl.style.scrollBehavior; panelsEl.style.scrollBehavior="auto";
  panelsEl.scrollTop=Math.max(0, panels[0].offsetTop-((panelsEl.clientHeight-panels[0].offsetHeight)/2)-13);
  panelsEl.style.scrollBehavior=pb;
  setFocus(0);
  setActiveGroup("main","#3987e5");
  requestAnimationFrame(updateTlIndicator);
});
window.addEventListener("resize",()=>requestAnimationFrame(layoutRails), SIG);

/* ================== 하단 타임라인 내비게이션 ================== */
const hmToMin=hm=>{ const [h,m]=String(hm).split(":").map(Number); return h*60+m; };
const MAIN_PATH=pathFrom(ROOT);
const TL_T0=hmToMin(MAIN_PATH[0].hm);
const TL_T1=MAIN_PATH.reduce((mx,n)=>Math.max(mx,hmToMin(n.hm)), TL_T0);

const tlBar=document.createElement("div");
tlBar.className="tl-bar";
tlBar.innerHTML=`<span class="tl-time">${esc(MAIN_PATH[0].hm)}</span><div class="tl-track"><div class="tl-band" style="display:none"></div><div class="tl-line" style="display:none"></div></div><span class="tl-time">${esc(MAIN_PATH[MAIN_PATH.length-1].hm)}</span>`;
_bodyAppend(tlBar);
const tlTrack=tlBar.querySelector(".tl-track");
const tlBand=tlBar.querySelector(".tl-band");
const tlLine=tlBar.querySelector(".tl-line");
const tlTip=document.createElement("div");
tlTip.className="tl-tip";
_bodyAppend(tlTip);

function tlPct(n){ return TL_T1>TL_T0 ? (hmToMin(n.hm)-TL_T0)/(TL_T1-TL_T0)*100 : 0; }
function tlFlash(node, color){
  const panel=panels[0]; if(!panel||!panel._rowByNode) return;
  const el=panel._rowByNode.get(node.id); if(!el||!el.isConnected) return;
  const sc=panel._scroller;
  sc.scrollTo({ top:Math.max(0, el.offsetTop - sc.clientHeight/2 + Math.min(el.offsetHeight, sc.clientHeight*0.6)/2), behavior:"smooth" });
  const target=el.classList.contains("msg-row") ? (el.querySelector(".bubble")||el) : el;
  target.style.setProperty("--fc", color);
  target.classList.remove("tl-flash"); void target.offsetWidth; target.classList.add("tl-flash");
  clearTimeout(target._tlFlashT);
  target._tlFlashT=setTimeout(()=>target.classList.remove("tl-flash"), 1300);
}

const tlMarkers=[];
const TL_DENSE = MAIN_PATH.length > 400;
let tlToolRun = 0;
MAIN_PATH.forEach((n, tlIdx)=>{
  if (TL_DENSE && n.kind === "tool") {
    tlToolRun++;
    const nx = MAIN_PATH[tlIdx+1];
    if (nx && nx.kind === "tool") return;      /* 연속 tool은 마지막 것 하나만 (개수는 title로) */
  }
  const mk=document.createElement("button");
  let cls="", html="", color="#3987e5", title="";
  const isAnchor=n.children.length>1;
  if(isAnchor){
    const sel=selectedChild(n);
    const alt=n.children.find(c=>c!==sel);
    const fm=alt&&forkMeta.get(alt.id);
    cls="anchor"; color=(fm&&fm.color)||"#e0b13e";
    mk.style.setProperty("--mc", color);
    title="분기 앵커"+(fm?" · "+fm.name:"");
  }
  else if(n.kind==="tool"){ cls="tool"; color="#8a8880"; title=TL_DENSE&&tlToolRun>1?`tool steps ×${tlToolRun}`:"tool step"; tlToolRun=0; }
  else if(n.kind==="think"){ return; }                        /* 사고 과정은 마커 생략 */
  else if(n.kind==="plan"){ cls="plan"; html=DOC_SVG; title="플랜 문서"; }
  else if(n.kind==="img"){ cls="img"; html="🖼"; title="이미지"; }
  else if(n.kind==="choice"){ cls="choice"; html="◈"; title="선택지"; }
  else if(n.role==="user"){ cls="user"; title="사용자"; }
  else { cls="asst"; color="#8a8880"; title="Claude"; }
  mk.className="tl-mk "+cls;
  if(html) mk.innerHTML=html;
  mk.style.left=tlPct(n)+"%";
  const preview=String(n.text).replace(/\s+/g," ").slice(0,120);
  mk.addEventListener("mouseenter",()=>{
    const r=mk.getBoundingClientRect();
    tlTip.innerHTML=`<b>${esc(n.hm)}${title?" · "+esc(title):""}</b>${esc(preview)}${n.text.length>120?"…":""}`;
    tlTip.style.display="block";
    const tw=tlTip.offsetWidth;
    tlTip.style.left=Math.max(8, Math.min(window.innerWidth-tw-8, r.left+r.width/2-tw/2))+"px";
    tlTip.style.top=(r.top-14-tlTip.offsetHeight)+"px";
  });
  mk.addEventListener("mouseleave",()=>{ tlTip.style.display="none"; });
  mk.addEventListener("click",e=>{ e.stopPropagation(); tlFlash(n, color); });
  tlTrack.appendChild(mk);
  tlMarkers.push({node:n, pct:tlPct(n)});
});

/* main 컬럼 스크롤 ↔ 현재 위치 인디케이터 동기화 */
function updateTlIndicator(){
  const panel=panels[0];
  if(!panel||!panel._rowByNode||!panel.isConnected){ tlBand.style.display="none"; tlLine.style.display="none"; return; }
  const sc=panel._scroller;
  const top=sc.scrollTop, bot=top+sc.clientHeight, cy=top+sc.clientHeight/2;
  let minP=Infinity, maxP=-Infinity, lineP=null, best=Infinity;
  tlMarkers.forEach(m=>{
    const el=panel._rowByNode.get(m.node.id); if(!el||!el.isConnected) return;
    const y=el.offsetTop, y2=y+el.offsetHeight;
    if(y2>=top && y<=bot){ minP=Math.min(minP,m.pct); maxP=Math.max(maxP,m.pct); }
    const d=Math.abs((y+y2)/2-cy);
    if(d<best){ best=d; lineP=m.pct; }
  });
  if(minP===Infinity){ tlBand.style.display="none"; }
  else { tlBand.style.display=""; tlBand.style.left=minP+"%"; tlBand.style.width=Math.max(1.2, maxP-minP)+"%"; }
  if(lineP===null){ tlLine.style.display="none"; }
  else { tlLine.style.display=""; tlLine.style.left=lineP+"%"; }
}
panels[0]._scroller.addEventListener("scroll",()=>requestAnimationFrame(updateTlIndicator));
window.addEventListener("resize",()=>requestAnimationFrame(updateTlIndicator), SIG);
  loadAnno();

  return function teardown(){
    AC.abort();
    bodyNodes.forEach(n=>{ try{ n.remove(); }catch{} });
    try { hidePop(); } catch {}
    try { canvasEl.remove(); } catch {}
  };
}
