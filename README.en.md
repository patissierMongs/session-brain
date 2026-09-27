# session-brain

Local-first episodic memory for Claude Code: it indexes session logs into SQLite and lets you search and browse them from a CLI (Command-Line Interface), an MCP (Model Context Protocol) server, a web UI (User Interface) and an Obsidian vault.

[한국어](README.md) | **English**

![Web UI demo: session list, canvas viewer, fork branch, command palette](docs/images/web-demo.gif)

| Session list | Fork branch column | Command palette |
|---|---|---|
| ![Session list](docs/images/web-list.png) | ![Fork branch](docs/images/web-branch.png) | ![Command palette](docs/images/web-palette.png) |

![CLI output](docs/images/cli.png)

All screenshots were captured from the actual binary running against the synthetic corpus in `web/test/gen-corpus.mjs`.

## Features

- **Session indexing**: scans the JSONL (JSON Lines) logs under `~/.claude/projects` and stores them in a SQLite cache at `~/.session-brain/index.db`. Only new or changed files are re-read; `index --full` rebuilds everything. Subagent transcripts are indexed separately.
- **Search**: three passes run in order.
  1. SQLite FTS5 (Full-Text Search 5) with bm25 (Best Matching 25) ranking
  2. Optional semantic pass with local Ollama embeddings, fused with the first pass via RRF (Reciprocal Rank Fusion)
  3. Literal substring scan, which also catches matches inside Korean compounds and identifiers, and reports the total match count
- **Branch (fork) tracking**: every line's `parentUuid` link is stored, so abandoned branches created by message edits or retries can be reconstructed.
- **Web UI** (`serve`): session list, infinite-canvas viewer, fork tree in the sidebar, fork branch columns, timeline, code windows, command palette (`⌘K`) and double-click notes (kept in the browser's localStorage).
- **MCP server** (`mcp`): exposes three tools over stdio so Claude can search its own past sessions: `sessions_search`, `sessions_get`, `sessions_recent`.
- **Obsidian export** (`export`): regenerates `Sessions/`, `Projects/`, `Home.md` and `sessions.base`.
- **Terminal viewing**: `show` prints a transcript and its `claude --resume` command; `stats` prints index statistics.

## Usage

### 1. Install

Requires the Rust toolchain (Cargo). The web UI is already built into `assets/app.html` and embedded in the binary, so Node.js is not needed.

```sh
git clone https://github.com/patissierMongs/session-brain
cd session-brain
cargo install --path .
```

### 2. Build the index

```sh
session-brain index                 # scan ~/.claude/projects
session-brain index --full          # rebuild everything
session-brain index --root <DIR>    # scan a different directory
session-brain stats
```

Use the global `--db <PATH>` option to put the database somewhere else.

### 3. Search and read

```sh
session-brain search "that bug we fixed"
session-brain search -p <project> -r user -n 10 rayon
session-brain show <session-id-prefix>
```

`-p` filters by project/cwd substring, `-r` by role (`user` or `assistant`), `-n` sets the result count, `-a` includes subagent transcripts.

### 4. Web UI

```sh
session-brain serve                 # http://localhost:7777
session-brain serve --port 8080
```

It binds to 127.0.0.1 only. Click a row in the list to open the canvas viewer, then click a fork card to open its branch column. `⌘K` (or the search box at the top) opens the palette.

### 5. Semantic search (optional)

Requires [Ollama](https://ollama.com) running locally.

```sh
ollama pull qwen3-embedding:8b
session-brain embed                 # incremental, safe to re-run
session-brain search -s "storage full error"
```

`embed` and `search` take `--model` and `--url`. The MCP server and the web API (Application Programming Interface) read the `SESSION_BRAIN_EMBED_MODEL` and `SESSION_BRAIN_OLLAMA_URL` environment variables instead (defaults: `qwen3-embedding:8b`, `http://localhost:11434`). If Ollama is unreachable, search falls back to the lexical passes.

### 6. Register as an MCP server

```sh
claude mcp add session-brain -s user -- session-brain mcp
```

### 7. Obsidian export

```sh
session-brain export --vault ~/Obsidian/SessionBrain
```

Files in the vault are regenerated on every run, so do not edit them by hand.

### Web UI development

```sh
cd web
npm install
npm run dev       # Vite dev server
npm run check     # TypeScript type check
npm run build     # writes ../assets/app.html
```

`assets/app.html` is committed on purpose so that `cargo install` needs no Node.js.

End-to-end test (Playwright, against a running server):

```sh
node web/test/gen-corpus.mjs /tmp/sb-projects
session-brain --db /tmp/sb.db index --root /tmp/sb-projects
session-brain --db /tmp/sb.db serve --port 7791 &
node web/test/e2e.mjs               # BASE defaults to http://localhost:7791
```

`e2e.mjs` imports the `playwright` package and launches Chromium from `/opt/pw-browsers/chromium`; adjust these to your environment.

### Windows build without MSVC

The project builds with the GNU (GNU's Not Unix) toolchain if MSVC (Microsoft Visual C++) Build Tools are not installed. Create these two machine-local files (both are gitignored):

`rust-toolchain.toml`
```toml
[toolchain]
channel = "stable-x86_64-pc-windows-gnu"
```

`.cargo/config.toml`
```toml
[build]
target = "x86_64-pc-windows-gnu"

[target.x86_64-pc-windows-gnu]
linker = "C:\\msys64\\ucrt64\\bin\\gcc.exe"
```

## Tech stack

| Area | Items |
|---|---|
| Language | Rust (edition 2021), TypeScript, JavaScript |
| CLI | clap 4 (derive) |
| Storage / search | rusqlite 0.37 (bundled SQLite, FTS5), sha2 0.10 |
| Web server | axum 0.8, tokio 1 |
| MCP | rmcp 1 (stdio transport), schemars 1 |
| Embeddings | Ollama HTTP (HyperText Transfer Protocol) API via ureq 2, default model `qwen3-embedding:8b` |
| Web UI | Vite 6, vite-plugin-singlefile 2, TypeScript 5, highlight.js 11 |
| Tests | Playwright end-to-end script (`web/test/e2e.mjs`) |

## Docs

- [Progress record](docs/PROGRESS.en.md) ([한국어](docs/PROGRESS.md))

## License

MIT (Massachusetts Institute of Technology) License. See [LICENSE](LICENSE).
