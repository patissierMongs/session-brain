// session-brain web UI — entry point & hash router.
// #/               → session list
// #/session/<id>   → canvas viewer (engine)
import "./styles.css";
import { api } from "./api";
import { renderList } from "./list";
import { mountSession } from "./engine.js";
import { esc } from "./util";

const app = document.getElementById("app")!;
app.innerHTML = `
  <div id="viewList" class="top-view"></div>
  <div id="viewCanvas" class="top-view" style="display:none"></div>
`;
const viewList = document.getElementById("viewList")!;
const viewCanvas = document.getElementById("viewCanvas")!;

// The canvas engine's shell markup (header / sidebar / panels) — the engine
// looks these elements up by id when mounted.
const CANVAS_SHELL = `
<div class="hdr">
  <a class="hdr-back" href="#/" title="세션 목록으로">←</a>
  <b id="hdrTitle">session-brain</b>
  <button class="searchbox" id="ckHint" title="커맨드 팔레트 열기 (⌘K)">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg>
    <span>메시지 · 파일 · 분기 · 메모 검색</span><kbd>⌘K</kbd>
  </button>
  <span class="concept" id="hdrMeta"></span>
  <button class="anno-count" id="annoCount" title="클릭하면 모든 메모·인용이 강조됩니다">메모 0 · 인용 0</button>
</div>
<div class="crumbs" id="crumbs"></div>
<div class="layout">
  <div class="sidebar">
    <div class="sb-title">세션 구조</div>
    <div class="tree" id="tree"><svg id="treeSvg"></svg></div>
    <div class="sb-foot" id="sbFoot"></div>
  </div>
  <div class="panels" id="panels"></div>
</div>
<div class="kbd-hint"><b>배경 드래그</b> 팬 · <b>휠</b> 줌 · <b>헤더/그립 드래그</b> 독립 창 · <b>더블클릭</b> 메모 · <b>Esc</b> 닫기</div>
`;

let teardown: (() => void) | null = null;

async function openSession(id: string) {
  if (teardown) { teardown(); teardown = null; }
  viewList.style.display = "none";
  viewCanvas.style.display = "";
  viewCanvas.innerHTML = `<div class="center-box"><div class="load"><span class="spin"></span>세션 불러오는 중…</div></div>`;
  let data;
  try {
    data = await api.session(id);
  } catch (err: any) {
    viewCanvas.innerHTML = `
      <div class="center-box"><div class="err-box">
        <h2>세션을 불러오지 못했습니다</h2>
        <p>${esc(err?.message || String(err))}</p>
        <a class="btn primary" href="#/">← 세션 목록</a>
      </div></div>`;
    return;
  }
  viewCanvas.innerHTML = CANVAS_SHELL;
  const m = data.meta || {};
  document.getElementById("hdrTitle")!.textContent = m.title || "(제목 없음)";
  document.getElementById("hdrMeta")!.textContent =
    `${m.project_name || m.project || ""} · ${m.user_msgs ?? 0}+${m.assistant_msgs ?? 0} msgs`;
  document.getElementById("sbFoot")!.innerHTML =
    `<b>${esc(m.title || "(제목 없음)")}</b>${esc((m.first_ts || "").slice(0, 10))} · ` +
    `<span class="mono">claude --resume ${esc(String(m.id || "").slice(0, 8))}…</span>`;
  document.title = `${m.title || id} — session-brain`;
  try {
    teardown = mountSession(data);
  } catch (err: any) {
    console.error(err);
    viewCanvas.innerHTML = `
      <div class="center-box"><div class="err-box">
        <h2>뷰어 초기화 실패</h2>
        <p>${esc(err?.message || String(err))}</p>
        <a class="btn primary" href="#/">← 세션 목록</a>
      </div></div>`;
  }
}

function route() {
  const h = location.hash || "#/";
  const m = h.match(/^#\/session\/(.+)$/);
  if (m) {
    void openSession(decodeURIComponent(m[1]));
  } else {
    if (teardown) { teardown(); teardown = null; }
    viewCanvas.style.display = "none";
    viewCanvas.innerHTML = "";
    viewList.style.display = "";
    document.title = "session-brain";
    void renderList(viewList);
  }
}
window.addEventListener("hashchange", route);
route();
