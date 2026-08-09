// Dev/e2e stub: serves dist/index.html + synthetic /api responses that
// mirror the Rust server's shapes (serve.rs).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PAGE = readFileSync(new URL("../dist/index.html", import.meta.url), "utf-8");

// ---- synthetic session with forks / tools / thinking / plan / choice ----
function mkSession(id, title, opts = {}) {
  const links = [];
  const messages = {};
  let line = 0;
  const push = (uuid, parent, role, msg) => {
    line += 1;
    links.push({ uuid, parent_uuid: parent, line_no: line, role, has_content: !!msg });
    if (msg) messages[uuid] = { role, ts: msg.ts, content: msg.content, kind: msg.kind || "text" };
    return uuid;
  };
  const T = (h, m) => `2026-08-07T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

  const u0 = push("u0", null, "user", { ts: T(14, 2), content: "인덱서가 큰 세션에서 panic 나. `Option::unwrap()` 확인해줘. [Image #1]" });
  const t1 = push("t1", u0, "assistant", { ts: T(14, 3), content: "Tool: Bash\n{\"command\":\"RUST_BACKTRACE=1 cargo run -- index\"}", kind: "tool" });
  const t2 = push("t2", t1, "user", { ts: T(14, 4), content: "→ thread 'main' panicked at src/parser.rs:214", kind: "tool" });
  const th = push("th", t2, "assistant", { ts: T(14, 5), content: "summary 레코드에는 parentUuid가 없다. Option으로 받아야 한다.", kind: "thinking" });
  const a1 = push("a1", th, "assistant", {
    ts: T(14, 6),
    content:
      "원인 확인. **summary 레코드**는 `parentUuid` 필드가 없습니다.\n```rust\nlet parent = rec.parent_uuid.unwrap(); // panic\n```",
  });
  const u1 = push("u1", a1, "user", { ts: T(14, 8), content: "어떻게 고치는 게 맞아?" });
  const a2 = push("a2", u1, "assistant", { ts: T(14, 10), content: "Option<Uuid> + root 취급을 제안합니다." });
  // Fork A (abandoned): from a2
  const fa0 = push("fa0", a2, "user", { ts: T(14, 12), content: "그냥 expect()로 메시지만 바꿔줘." });
  push("fa1", fa0, "assistant", { ts: T(14, 13), content: "panic 자체는 그대로라 근본 수정을 권합니다." });
  // main continues from a2 (later lines → main path)
  const u2 = push("u2", a2, "user", { ts: T(14, 15), content: "좋아, 근본 수정으로 가자. 계획 세워줘." });
  const pl = push("pl", u2, "assistant", {
    ts: T(14, 16),
    content: 'Tool: ExitPlanMode\n{"plan":"1. Option<Uuid> 전환\\n2. root 취급 분기\\n3. 회귀 테스트 3종"}',
    kind: "tool",
  });
  const t3 = push("t3", pl, "assistant", { ts: T(14, 18), content: 'Tool: Edit\n{"file_path":"src/parser.rs"}', kind: "tool" });
  const t4 = push("t4", t3, "user", { ts: T(14, 19), content: "→ 12 passed, 0 failed", kind: "tool" });
  const a3 = push("a3", t4, "assistant", {
    ts: T(14, 20),
    content: "수정 완료.\n```rust\n#[serde(default, rename = \"parentUuid\")]\nparent_uuid: Option<Uuid>,\n```",
  });
  const ch = push("ch", a3, "assistant", {
    ts: T(14, 22),
    content:
      'Tool: AskUserQuestion\n{"questions":[{"question":"다음 최적화 방향은?","options":[{"label":"simd-json 도입"},{"label":"rayon 병렬화"}]}]}',
    kind: "tool",
  });
  const chr = push("chr", ch, "user", { ts: T(14, 23), content: '→ {"다음 최적화 방향은?":"rayon 병렬화"}', kind: "tool" });
  // attachment pass-through (link only, no content) — viewer must splice, not fork
  const att1 = push("att1", chr, "attachment", null);
  const u3 = push("u3", att1, "user", { ts: T(14, 25), content: "rayon으로 구현해줘." });
  // Fork B from u3's answer point (nested fork inside)
  const a4 = push("a4", u3, "assistant", { ts: T(14, 30), content: "구현했습니다. 4m02s → 41s (5.9배)." });
  const fb0 = push("fb0", a4, "user", { ts: T(14, 32), content: "잠깐, tokio async 전면 재작성은 어때?" });
  const fb1 = push("fb1", fb0, "assistant", { ts: T(14, 34), content: "규모가 큽니다. IndexWriter가 blocking이라 이점이 제한적입니다." });
  push("fc0", fb1, "user", { ts: T(14, 36), content: "async-std는?" });
  const u4 = push("u4", a4, "user", { ts: T(14, 40), content: "됐고, 이대로 커밋해줘." });
  const a5 = push("a5", u4, "assistant", { ts: T(14, 42), content: "커밋 완료: feat(indexer): rayon parallel indexing" });
  void a5;
  // compaction boundary: new root segment — viewer must chain it as continuation
  const sys1 = push("sys1", null, "system", null);
  const u5 = push("u5", sys1, "user", { ts: T(14, 45), content: "컴팩션 후에도 이어서: 릴리즈 노트 정리해줘." });
  push("a6", u5, "assistant", { ts: T(14, 46), content: "릴리즈 노트 초안입니다." });
  // dangling metadata record — viewer must prune
  push("qo1", null, "queue-operation", null);

  const um = Object.values(messages).filter((m) => m.role === "user" && m.kind === "text").length;
  const am = Object.values(messages).filter((m) => m.role === "assistant" && m.kind === "text").length;
  return {
    meta: {
      id, project: "C--dev-session-brain", project_name: opts.project_name || "session-brain",
      cwd: "/dev/session-brain", title, git_branch: "main",
      first_ts: T(14, 2), last_ts: T(14, 42),
      user_msgs: um, assistant_msgs: am, subagents: 0,
    },
    links, messages,
  };
}

const S1 = mkSession("aaaa1111-0000-0000-0000-000000000001", "인덱서 panic 수정 & rayon 병렬화");
const S2 = mkSession("bbbb2222-0000-0000-0000-000000000002", "두 번째 테스트 세션", { project_name: "other-proj" });
const ALL = { [S1.meta.id]: S1, [S2.meta.id]: S2 };

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  if (url.pathname === "/api/sessions") {
    return send(200, {
      sessions: Object.values(ALL).map((s) => ({
        id: s.meta.id, project: s.meta.project, project_name: s.meta.project_name,
        title: s.meta.title, first_ts: s.meta.first_ts, last_ts: s.meta.last_ts,
        user_msgs: s.meta.user_msgs, assistant_msgs: s.meta.assistant_msgs, subagents: 0,
      })),
    });
  }
  const m = url.pathname.match(/^\/api\/session\/(.+)$/);
  if (m) {
    const hit = Object.values(ALL).find((s) => s.meta.id.startsWith(decodeURIComponent(m[1])));
    return hit ? send(200, hit) : send(404, { error: "not found" });
  }
  if (url.pathname === "/api/search") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const hits = [];
    for (const s of Object.values(ALL)) {
      for (const [, msg] of Object.entries(s.messages)) {
        if (msg.kind === "text" && msg.content.toLowerCase().includes(q)) {
          hits.push({
            session_id: s.meta.id, project: s.meta.project_name, title: s.meta.title,
            role: msg.role, ts: msg.ts, snippet: msg.content.slice(0, 140), kind: "main",
          });
          if (hits.length >= 20) break;
        }
      }
    }
    return send(200, { hits, scan_total: hits.length, semantic_note: "semantic pass skipped: stub" });
  }
  return send(200, PAGE, "text/html; charset=utf-8");
});
server.listen(7791, () => console.log("stub on http://localhost:7791"));
