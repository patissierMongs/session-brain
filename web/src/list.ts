// Session list view — the entry screen. Click a row → canvas viewer.
import { api, SessionSummary } from "./api";
import { esc, fmtDT } from "./util";

export async function renderList(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="center-box"><div class="load"><span class="spin"></span>세션 목록 불러오는 중…</div></div>`;
  let sessions: SessionSummary[];
  try {
    sessions = (await api.sessions()).sessions;
  } catch (err: any) {
    root.innerHTML = `
      <div class="center-box"><div class="err-box">
        <h2>데이터를 불러오지 못했습니다</h2>
        <p>${esc(err?.message || String(err))}</p>
        <p class="hint">session-brain serve 가 실행 중인지, 인덱스가 생성됐는지(<code>session-brain index</code>) 확인하세요.</p>
        <button class="btn primary" id="retry">다시 시도</button>
      </div></div>`;
    root.querySelector("#retry")?.addEventListener("click", () => renderList(root));
    return;
  }

  root.innerHTML = `
    <div class="page"><div class="page-inner">
      <h1>세션 목록</h1>
      <div class="sub">episodic memory에 인덱싱된 Claude Code 세션 · ${sessions.length}개 · <span class="hint-inline">세션을 열면 캔버스 뷰어 (⌘K 검색)</span></div>
      <div class="toolbar">
        <input type="search" id="listFilter" placeholder="프로젝트 / 제목으로 필터…" autocomplete="off">
      </div>
      <div class="sess-list" id="sessList"></div>
    </div></div>`;

  const listEl = root.querySelector<HTMLElement>("#sessList")!;
  const draw = (filter: string) => {
    const f = filter.trim().toLowerCase();
    const rows = sessions.filter(
      (s) =>
        !f ||
        (s.project_name || "").toLowerCase().includes(f) ||
        (s.title || "").toLowerCase().includes(f) ||
        (s.project || "").toLowerCase().includes(f),
    );
    if (!rows.length) {
      listEl.innerHTML = `<div class="list-empty">일치하는 세션이 없습니다.</div>`;
      return;
    }
    listEl.innerHTML = rows
      .map(
        (s) => `
      <div class="sess-row" data-id="${esc(s.id)}" role="link" tabindex="0">
        <span class="d">${esc(fmtDT(s.last_ts))}</span>
        <span class="p"><span class="pchip">${esc(s.project_name || s.project || "?")}</span></span>
        <span class="t">${esc(s.title || "(제목 없음)")}</span>
        <span class="m"><span>👤 <b>${s.user_msgs ?? 0}</b></span><span>✳ <b>${s.assistant_msgs ?? 0}</b></span><span>sub <b>${s.subagents ?? 0}</b></span></span>
      </div>`,
      )
      .join("");
    listEl.querySelectorAll<HTMLElement>(".sess-row").forEach((el) => {
      const go = () => { location.hash = "#/session/" + encodeURIComponent(el.dataset.id!); };
      el.addEventListener("click", go);
      el.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") go(); });
    });
  };
  draw("");
  root.querySelector<HTMLInputElement>("#listFilter")!.addEventListener("input", (e) =>
    draw((e.target as HTMLInputElement).value),
  );
}
