# session-brain

Local-first **episodic memory** for Claude Code.

Your `~/.claude/projects/**/*.jsonl` session logs are the immutable source of
truth; session-brain builds a **disposable SQLite cache** on top of them and
gives you four ways in:

| Interface | For | Command |
|---|---|---|
| CLI | quick lookups | `session-brain search "..."` |
| **MCP server** | Claude itself (long-term memory tools) | `session-brain mcp` |
| **Web UI** | humans — canvas viewer with branch (fork) trees | `session-brain serve` |
| Obsidian export | linking / knowledge layer | `session-brain export` |

## Why

Claude Code CLI keeps every session as JSONL, including **abandoned branches**
(`parentUuid` trees from message edits and retries) — but nothing reads them.
session-brain indexes everything (messages, tool steps, thinking), searches it
three ways (FTS5 bm25 → optional local-LLM semantic pass fused via RRF → literal
substring scan for full recall), and renders sessions as an **infinite canvas**:
flow columns per branch, floating copies, tabbed code windows, a command
palette, timeline navigation, and annotations.

## Quick start

```sh
cargo install --path .
session-brain index            # scan ~/.claude/projects
session-brain serve            # web UI on http://localhost:7777
session-brain search "that bug we fixed"
```

Optional semantic layer (local, via [Ollama](https://ollama.com)):

```sh
ollama pull qwen3-embedding:8b
session-brain embed            # incremental; safe to re-run
session-brain search -s "storage full error"   # hybrid lexical+semantic
```

Register as an MCP server so Claude can search its own past:

```sh
claude mcp add session-brain -s user -- session-brain mcp
```

Obsidian export (regenerated derived views — don't hand-edit):

```sh
session-brain export --vault ~/Obsidian/SessionBrain
```

## Web UI development

The web UI lives in `web/` (Vite + TypeScript) and is built into a single
self-contained HTML file embedded in the Rust binary:

```sh
cd web
npm install
npm run build        # → ../assets/app.html (committed, so `cargo install` needs no Node)
```

`assets/app.html` is a **committed build artifact** on purpose: installing the
binary requires only Cargo.

## Windows build (no MSVC)

This project builds fine with the GNU toolchain. If you don't have MSVC Build
Tools, create two machine-local files (they are intentionally gitignored):

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
linker = "C:\\msys64\\ucrt64\\bin\\gcc.exe"   # MSYS2 ucrt64 gcc
```

## Design notes

- **JSONL = truth, SQLite = cache.** `index --full` rebuilds everything;
  embeddings survive rebuilds (keyed by message uuid + content hash).
- **Recall over cleverness.** Search always ends with a literal substring pass
  and reports the honest total match count.
- **Branches are first-class.** The `links` table stores the complete
  `parentUuid` chain for every line, so the viewer reconstructs fork trees
  exactly; the main branch is the path to the newest leaf.
- Ports/URLs are localhost-only. Nothing leaves your machine.

## License

MIT
