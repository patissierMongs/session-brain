// Generate a synthetic ~/.claude/projects-style JSONL corpus for full-stack e2e.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] || "/tmp/sb-projects";
const proj = join(root, "C--dev-session-brain");
mkdirSync(proj, { recursive: true });

const SID = "e2e00001-1111-2222-3333-444444444444";
const T = (m, s = 0) =>
  `2026-08-07T14:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;

const lines = [];
let li = 0;
const line = (obj) => { lines.push(JSON.stringify(obj)); li += 1; };
const msg = (uuid, parent, role, content, min, extra = {}) =>
  line({
    type: role, uuid, parentUuid: parent, sessionId: SID, timestamp: T(min),
    cwd: "/dev/session-brain", gitBranch: "main",
    message: { model: role === "assistant" ? "claude-fable-5" : undefined, content },
    ...extra,
  });

line({ type: "summary", summary: "인덱서 panic 수정과 rayon 병렬화", sessionId: SID });

msg("u0", null, "user", "인덱서가 큰 세션에서 panic 나. `Option::unwrap()` 확인해줘. [Image #1]", 2);
msg("t1", "u0", "assistant", [
  { type: "thinking", thinking: "summary 레코드에는 parentUuid가 없다. Option으로 받아야 한다." },
], 3);
msg("t2", "t1", "assistant", [
  { type: "tool_use", name: "Bash", input: { command: "RUST_BACKTRACE=1 cargo run -- index" } },
], 4);
msg("t3", "t2", "user", [
  { type: "tool_result", content: "thread 'main' panicked at src/parser.rs:214" },
], 5);
msg("a1", "t3", "assistant", [
  { type: "text", text: "원인 확인. **summary 레코드**는 `parentUuid` 필드가 없습니다.\n```rust\nlet parent = rec.parent_uuid.unwrap(); // panic\n```" },
], 6);
msg("u1", "a1", "user", "어떻게 고치는 게 맞아?", 8);
msg("a2", "u1", "assistant", [{ type: "text", text: "Option<Uuid> + root 취급을 제안합니다." }], 10);
// Fork A (abandoned — earlier lines than main continuation)
msg("fa0", "a2", "user", "그냥 expect()로 메시지만 바꿔줘.", 12);
msg("fa1", "fa0", "assistant", [{ type: "text", text: "panic 자체는 그대로라 근본 수정을 권합니다." }], 13);
// main continues
msg("u2", "a2", "user", "좋아, 근본 수정으로 가자. 계획 세워줘.", 15);
msg("pl", "u2", "assistant", [
  { type: "tool_use", name: "ExitPlanMode", input: { plan: "1. Option<Uuid> 전환\n2. root 취급 분기\n3. 회귀 테스트 3종" } },
], 16);
msg("t4", "pl", "assistant", [
  { type: "tool_use", name: "Edit", input: { file_path: "src/parser.rs", old_string: "unwrap()", new_string: "root 취급" } },
], 18);
msg("t5", "t4", "user", [{ type: "tool_result", content: "12 passed, 0 failed" }], 19);
msg("a3", "t5", "assistant", [
  { type: "text", text: "수정 완료.\n```rust\n#[serde(default, rename = \"parentUuid\")]\nparent_uuid: Option<Uuid>,\n```" },
], 20);
msg("ch", "a3", "assistant", [
  { type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "다음 최적화 방향은?", options: [{ label: "simd-json 도입" }, { label: "rayon 병렬화" }] }] } },
], 22);
msg("chr", "ch", "user", [{ type: "tool_result", content: '{"다음 최적화 방향은?":"rayon 병렬화"}' }], 23);
// attachment record mid-chain: real logs thread parentUuid THROUGH these —
// must not break the tree into a fake fork
line({ type: "attachment", uuid: "att1", parentUuid: "chr", sessionId: SID, timestamp: T(24) });
msg("u3", "att1", "user", "rayon으로 구현해줘.", 25);
msg("a4", "u3", "assistant", [{ type: "text", text: "구현했습니다. 4m02s → 41s (5.9배)." }], 30);
// Fork B with nested fork
msg("fb0", "a4", "user", "잠깐, tokio async 전면 재작성은 어때?", 32);
msg("fb1", "fb0", "assistant", [{ type: "text", text: "규모가 큽니다. IndexWriter가 blocking이라 이점이 제한적입니다." }], 34);
msg("fc0", "fb1", "user", "async-std는?", 36);
msg("u4", "a4", "user", "됐고, 이대로 커밋해줘.", 40);
msg("a5", "u4", "assistant", [{ type: "text", text: "커밋 완료: feat(indexer): rayon parallel indexing" }], 42);
// compaction boundary: post-compact records start a NEW root segment —
// must render as continuation of the main thread, not as a fork
line({ type: "system", subtype: "compact_boundary", uuid: "sys1", parentUuid: null, sessionId: SID, timestamp: T(44) });
msg("u5", "sys1", "user", "컴팩션 후에도 이어서: 릴리즈 노트 정리해줘.", 45);
msg("a6", "u5", "assistant", [{ type: "text", text: "릴리즈 노트 초안입니다." }], 46);
// dangling metadata record with uuid but no chain participation — must be pruned
line({ type: "queue-operation", uuid: "qo1", parentUuid: null, sessionId: SID, timestamp: T(47) });

writeFileSync(join(proj, `${SID}.jsonl`), lines.join("\n") + "\n");

// A second, linear session (list should show 2)
const SID2 = "e2e00002-aaaa-bbbb-cccc-dddddddddddd";
const l2 = [
  JSON.stringify({ type: "summary", summary: "선형 세션 (분기 없음)", sessionId: SID2 }),
  JSON.stringify({ type: "user", uuid: "x0", parentUuid: null, sessionId: SID2, timestamp: T(50), cwd: "/dev/other", message: { content: "짧은 질문 하나." } }),
  JSON.stringify({ type: "assistant", uuid: "x1", parentUuid: "x0", sessionId: SID2, timestamp: T(51), message: { model: "claude-fable-5", content: [{ type: "text", text: "짧은 답변입니다." }] } }),
];
writeFileSync(join(proj, `${SID2}.jsonl`), l2.join("\n") + "\n");

console.log(`corpus → ${root} (${lines.length + l2.length} lines)`);
