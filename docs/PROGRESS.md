# 진행 기록

[English](PROGRESS.en.md)

## 최종 목표

Claude Code가 남기는 세션 JSONL(JSON Lines) 로그를 원본으로 두고, 그 위에 언제든 다시 만들 수 있는 SQLite 캐시를 쌓아 지난 작업을 찾아보게 하는 로컬 전용 도구입니다. 사람은 CLI(Command-Line Interface), 웹 UI(User Interface), Obsidian 보관함으로 열람하고, Claude는 MCP(Model Context Protocol) 서버로 자기 과거 세션을 검색합니다. 메시지 수정이나 재시도로 생긴 분기까지 그대로 복원해 보여 주는 것이 목표에 포함됩니다.

## 현재 구현 상태

아래 상태는 코드를 직접 읽고, 합성 데이터(`web/test/gen-corpus.mjs`)로 바이너리를 실행해 확인했습니다.

| 기능 | 상태 | 근거 코드 | 확인 방법 |
|---|---|---|---|
| JSONL 증분 색인 (`index`, `--full`, `--root`) | 구현됨 | `src/main.rs` `cmd_index`, `src/db.rs` `files` 테이블, `file_unchanged` | 실행 확인 |
| 서브에이전트 기록 구분 색인 | 구현됨 | `src/main.rs` `cmd_index`(`subagents/` 경로 처리), `sessions.kind` | 코드 확인, 합성 데이터에는 서브에이전트 없음 |
| 분기 연결 저장 (`parentUuid`) | 구현됨 | `src/db.rs` `links` 테이블 | E2E(End-to-End) 테스트의 분기 개수 검사 통과 |
| FTS5(Full-Text Search 5) 검색, bm25(Best Matching 25) 순위 | 구현됨 | `src/search.rs` `run_search` 1단계 | 실행 확인 |
| 문자열 부분 일치 검색, 전체 건수 보고 | 구현됨 | `src/search.rs` `run_search` 3단계 | 실행 확인 |
| Ollama 임베딩 (`embed`), 의미 검색, RRF(Reciprocal Rank Fusion) 병합 | 구현됨 | `src/main.rs` `cmd_embed`, `src/ollama.rs`, `src/search.rs` `semantic_pass`, `rrf_merge` | 코드 확인. 이 환경에 Ollama가 없어 임베딩은 실행하지 못했고, `search -s`가 어휘 검색으로 넘어가는 동작만 확인 |
| 터미널 열람 (`show`, `stats`) | 구현됨 | `src/main.rs` `cmd_show`, `cmd_stats` | 실행 확인 |
| MCP 서버 (`sessions_search`, `sessions_get`, `sessions_recent`) | 구현됨 | `src/mcp.rs` | `initialize`, `tools/list` 요청으로 확인 |
| Obsidian 내보내기 (`Sessions/`, `Projects/`, `Home.md`, `sessions.base`) | 구현됨 | `src/export.rs` `run` | 실행 확인 |
| 웹 서버 (`serve`, 127.0.0.1 바인딩, UI 내장) | 구현됨 | `src/serve.rs`, `assets/app.html` | 실행 확인 |
| 웹 UI: 목록, 캔버스, 분기 트리/컬럼, 타임라인, 코드 창, 팔레트, 메모 | 구현됨 | `web/src/list.ts`, `web/src/main.ts`, `web/src/engine.js` | E2E 23/23 통과 |
| 웹 UI의 서버 검색 (`/api/search`) | 부분 구현 | `src/serve.rs` `api_search`, `web/src/api.ts` `api.search` | 엔드포인트와 클라이언트 함수는 있으나 UI 어디에서도 호출하지 않음. 팔레트는 열린 세션 안에서만 찾음 |
| 웹 UI 메모 서버 저장 | 미구현 | `web/src/engine.js` (localStorage만 사용) | 코드 확인 |
| Rust 단위 테스트 | 미구현 | `cargo test` 결과 0개 | 실행 확인 |

## 작업 이력

`git log`에 저장된 커밋 시각을 KST(Korea Standard Time)로 바꿔 적었습니다. 일부 커밋은 `+0000`(UTC, Coordinated Universal Time), 일부는 `+0900`으로 저장되어 있어 모두 UTC+9로 환산했습니다.

| 날짜 (KST) | 커밋 | 내용 |
|---|---|---|
| 2026-08-09 04:29 | `b7c4392` | session-brain v0.7 핵심 코드 가져오기 (색인, 하이브리드 검색, MCP, Obsidian 내보내기, 웹 UI v4) |
| 2026-08-09 04:37 | `3880ee3` | Vite + TypeScript 캔버스 뷰어 추가, 실제 API(Application Programming Interface) 연동 |
| 2026-08-09 04:42 | `15038f3` | 실제 Rust 서버와 합성 JSONL 데이터로 E2E 테스트 통과 |
| 2026-08-09 05:50 | `139f7f4` | 단일 파일로 빌드한 UI를 `assets/app.html`에 포함 |
| 2026-08-09 05:52 | `9a325f0` | `package-lock.json` 정리 |
| 2026-08-09 12:20 | `9b6cd53` | 선형 작업이 분기로 잘못 분류되던 문제 수정 |
| 2026-08-09 12:24 | `875e792` | 분기 분류 수정을 반영해 UI 다시 빌드 |
| 2026-09-27 | 이번 작업 | README 한국어/영어 분리, 스크린샷 추가, 진행 기록 작성 |
