# Progress record

[한국어](PROGRESS.md)

## Final goal

A local-only tool that keeps Claude Code's session JSONL (JSON Lines) logs as the source of truth and builds a rebuildable SQLite cache on top of them, so past work can be found again. People browse it through a CLI (Command-Line Interface), a web UI (User Interface) and an Obsidian vault; Claude searches its own past sessions through an MCP (Model Context Protocol) server. Reconstructing branches created by message edits and retries is part of the goal.

## Current implementation status

Statuses below were checked by reading the code and by running the binary on the synthetic corpus (`web/test/gen-corpus.mjs`).

| Feature | Status | Code | How verified |
|---|---|---|---|
| Incremental JSONL indexing (`index`, `--full`, `--root`) | Implemented | `src/main.rs` `cmd_index`, `src/db.rs` `files` table, `file_unchanged` | Ran it |
| Subagent transcripts indexed separately | Implemented | `src/main.rs` `cmd_index` (`subagents/` path handling), `sessions.kind` | Code read; synthetic corpus has no subagents |
| Branch linkage storage (`parentUuid`) | Implemented | `src/db.rs` `links` table | E2E (end-to-end) fork-count check passes |
| FTS5 (Full-Text Search 5) search with bm25 (Best Matching 25) ranking | Implemented | `src/search.rs` `run_search` pass 1 | Ran it |
| Literal substring scan with total match count | Implemented | `src/search.rs` `run_search` pass 3 | Ran it |
| Ollama embeddings (`embed`), semantic search, RRF (Reciprocal Rank Fusion) fusion | Implemented | `src/main.rs` `cmd_embed`, `src/ollama.rs`, `src/search.rs` `semantic_pass`, `rrf_merge` | Code read. Ollama is not available here, so embedding was not run; only the fallback of `search -s` to lexical search was observed |
| Terminal viewing (`show`, `stats`) | Implemented | `src/main.rs` `cmd_show`, `cmd_stats` | Ran it |
| MCP server (`sessions_search`, `sessions_get`, `sessions_recent`) | Implemented | `src/mcp.rs` | Sent `initialize` and `tools/list` |
| Obsidian export (`Sessions/`, `Projects/`, `Home.md`, `sessions.base`) | Implemented | `src/export.rs` `run` | Ran it |
| Web server (`serve`, binds 127.0.0.1, embedded UI) | Implemented | `src/serve.rs`, `assets/app.html` | Ran it |
| Web UI: list, canvas, fork tree/columns, timeline, code windows, palette, notes | Implemented | `web/src/list.ts`, `web/src/main.ts`, `web/src/engine.js` | E2E 23/23 passed |
| Server-side search in the web UI (`/api/search`) | Partial | `src/serve.rs` `api_search`, `web/src/api.ts` `api.search` | Endpoint and client function exist but nothing in the UI calls them; the palette only searches the open session |
| Server-side storage for web UI notes | Not started | `web/src/engine.js` (localStorage only) | Code read |
| Rust unit tests | Not started | `cargo test` runs 0 tests | Ran it |

## Work history

Commit times from `git log`, converted to KST (Korea Standard Time). Some commits are stored with `+0000` (UTC, Coordinated Universal Time) and some with `+0900`; all were converted to UTC+9.

| Date (KST) | Commit | Change |
|---|---|---|
| 2026-08-09 04:29 | `b7c4392` | Import session-brain v0.7 core (indexer, hybrid search, MCP, Obsidian export, web UI v4) |
| 2026-08-09 04:37 | `3880ee3` | Add Vite + TypeScript canvas viewer wired to the real API (Application Programming Interface) |
| 2026-08-09 04:42 | `15038f3` | E2E test passing against the real Rust server and a synthetic JSONL corpus |
| 2026-08-09 05:50 | `139f7f4` | Embed the single-file UI build into `assets/app.html` |
| 2026-08-09 05:52 | `9a325f0` | Normalize `package-lock.json` |
| 2026-08-09 12:20 | `9b6cd53` | Fix linear work being misclassified as forks |
| 2026-08-09 12:24 | `875e792` | Rebuild the embedded UI with the fork-classification fix |
| 2026-09-27 | this work | Split README into Korean/English, add screenshots, add progress record |
