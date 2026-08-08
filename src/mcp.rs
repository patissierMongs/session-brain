//! MCP server (stdio): exposes the session index to LLM clients as tools.
//! Register with: claude mcp add session-brain -s user -- session-brain mcp
//! NOTE: stdio transport — never print to stdout here (stderr only).

use crate::db;
use crate::search::{run_search, SearchOpts};
use anyhow::Result;
use rmcp::{
    ErrorData as McpError, ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router,
    transport::stdio,
};
use rusqlite::params;
use std::path::PathBuf;

use crate::ollama::{default_model as embed_model, default_url as ollama_url};

fn internal<E: std::fmt::Display>(e: E) -> McpError {
    McpError::internal_error(format!("{e}"), None)
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SearchParams {
    /// What to look for. Terms are prefix- and substring-matched (Korean
    /// particles and partial identifiers are fine). If results miss, retry
    /// with fewer or different terms.
    pub query: String,
    /// Add an embedding-based semantic pass (finds paraphrases and
    /// conceptually similar content). Default true; silently degrades to
    /// lexical-only when the local Ollama is unavailable.
    pub semantic: Option<bool>,
    /// Filter by project directory name or cwd substring (e.g. "ScanOps")
    pub project: Option<String>,
    /// Max results (default 10, max 50)
    pub limit: Option<u32>,
    /// Also search subagent/workflow transcripts (default false: main
    /// sessions only)
    pub include_subagents: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct GetParams {
    /// Session id from sessions_search or sessions_recent (a unique prefix
    /// is enough)
    pub session_id: String,
    /// Message offset for pagination (default 0)
    pub offset: Option<u32>,
    /// Max messages to return (default 20, max 200)
    pub max_messages: Option<u32>,
    /// Max characters per message before truncation (default 700)
    pub max_chars: Option<u32>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct RecentParams {
    /// Max sessions to list (default 10, max 50)
    pub limit: Option<u32>,
    /// Filter by project directory name or cwd substring
    pub project: Option<String>,
}

#[derive(Clone)]
pub struct SessionBrainServer {
    db_path: PathBuf,
    #[allow(dead_code)] // read by the #[tool_handler] macro expansion
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl SessionBrainServer {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            tool_router: Self::tool_router(),
        }
    }

    fn conn(&self) -> Result<rusqlite::Connection, McpError> {
        db::open(&self.db_path)
            .map_err(|e| McpError::internal_error(format!("failed to open index db: {e:#}"), None))
    }

    #[tool(
        description = "Search the user's past Claude Code sessions — their long-term coding memory. Hybrid lexical + semantic search over indexed transcripts. Use for questions like 'have we solved this before?', 'what was decided about X?', 'find the session where we fixed Y'. Each result carries a session_id; pass it to sessions_get to read the surrounding conversation."
    )]
    async fn sessions_search(
        &self,
        Parameters(p): Parameters<SearchParams>,
    ) -> Result<CallToolResult, McpError> {
        let conn = self.conn()?;
        let model = embed_model();
        let url = ollama_url();
        let limit = p.limit.unwrap_or(10).clamp(1, 50) as usize;
        let out = run_search(
            &conn,
            &SearchOpts {
                query: &p.query,
                project: p.project,
                role: None,
                limit,
                all: p.include_subagents.unwrap_or(false),
                semantic: p.semantic.unwrap_or(true),
                model: &model,
                url: &url,
            },
        )
        .map_err(|e| McpError::internal_error(format!("search failed: {e:#}"), None))?;

        let mut s = String::new();
        if out.hits.is_empty() {
            s.push_str(
                "No matches. Try fewer/different terms, include_subagents=true, or drop the project filter.",
            );
        }
        for (i, h) in out.hits.iter().take(limit).enumerate() {
            let day = h.ts.get(..10).unwrap_or("");
            let title = if h.title.is_empty() {
                "(untitled)"
            } else {
                &h.title
            };
            let mark = if h.kind == "subagent" { ", subagent" } else { "" };
            s.push_str(&format!(
                "{}. [{}] {} · {} (session_id={}, {}{})\n   {}\n",
                i + 1,
                day,
                h.proj,
                title,
                h.sid,
                h.role,
                mark,
                h.snip.replace('\n', " ")
            ));
        }
        if let Some(n) = &out.semantic_note {
            s.push_str(&format!("\nnote: {n}\n"));
        }
        if out.scan_total as usize > out.hits.len().min(limit) {
            s.push_str(&format!(
                "\nnote: {} literal matches in total, showing {} — narrow with the project filter or raise limit.\n",
                out.scan_total,
                out.hits.len().min(limit)
            ));
        }
        Ok(CallToolResult::success(vec![Content::text(s)]))
    }

    #[tool(
        description = "Read the transcript of one past session (paginated). Returns session metadata, messages in order, and the exact `claude --resume` command to reopen that session."
    )]
    async fn sessions_get(
        &self,
        Parameters(p): Parameters<GetParams>,
    ) -> Result<CallToolResult, McpError> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, project, COALESCE(title,'(untitled)'), COALESCE(cwd,'?'),
                        COALESCE(first_ts,''), COALESCE(last_ts,'')
                 FROM sessions WHERE id LIKE ?1||'%' LIMIT 4",
            )
            .map_err(internal)?;
        let cands: Vec<(String, String, String, String, String, String)> = stmt
            .query_map(params![p.session_id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })
            .map_err(internal)?
            .collect::<std::result::Result<_, _>>()
            .map_err(internal)?;
        if cands.is_empty() {
            return Err(McpError::invalid_params(
                format!(
                    "no session matching '{}' — find ids via sessions_search or sessions_recent",
                    p.session_id
                ),
                None,
            ));
        }
        if cands.len() > 1 {
            let ids: Vec<&str> = cands.iter().map(|c| c.0.as_str()).collect();
            return Err(McpError::invalid_params(
                format!(
                    "ambiguous session id prefix '{}': {}",
                    p.session_id,
                    ids.join(", ")
                ),
                None,
            ));
        }
        let (id, project, title, cwd, first, last) = &cands[0];
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        let offset = p.offset.unwrap_or(0) as i64;
        let max_messages = p.max_messages.unwrap_or(20).clamp(1, 200) as i64;
        let max_chars = p.max_chars.unwrap_or(700).clamp(50, 10_000) as usize;

        let mut s = format!(
            "session: {id}\nproject: {project}\ntitle: {title}\ncwd: {cwd}\nspan: {first} → {last}\nresume: claude --resume {id}   (run inside {cwd})\nmessages {}–{} of {total}:\n\n",
            offset + 1,
            (offset + max_messages).min(total),
        );
        let mut stmt = conn
            .prepare(
                "SELECT role, COALESCE(ts,''), content FROM messages
                 WHERE session_id = ?1 ORDER BY line_no LIMIT ?2 OFFSET ?3",
            )
            .map_err(internal)?;
        let rows = stmt
            .query_map(params![id, max_messages, offset], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(internal)?;
        for row in rows {
            let (role, ts, content) = row.map_err(internal)?;
            let mut text: String = content.chars().take(max_chars).collect();
            if text.len() < content.len() {
                text.push('…');
            }
            s.push_str(&format!("── {role} [{ts}] ──\n{text}\n\n"));
        }
        let next = offset + max_messages;
        if next < total {
            s.push_str(&format!("(has_more: call again with offset={next})\n"));
        }
        Ok(CallToolResult::success(vec![Content::text(s)]))
    }

    #[tool(
        description = "List the user's most recent Claude Code sessions (newest first) with project, title and session_id. Good starting point for 'what was I working on recently?'."
    )]
    async fn sessions_recent(
        &self,
        Parameters(p): Parameters<RecentParams>,
    ) -> Result<CallToolResult, McpError> {
        let conn = self.conn()?;
        let limit = p.limit.unwrap_or(10).clamp(1, 50) as i64;
        let mut stmt = conn
            .prepare(
                "SELECT id, project, COALESCE(title,'(untitled)'), COALESCE(last_ts,''),
                        user_msgs + assistant_msgs
                 FROM sessions
                 WHERE kind = 'main'
                   AND (?1 IS NULL OR project LIKE '%'||?1||'%' OR COALESCE(cwd,'') LIKE '%'||?1||'%')
                 ORDER BY last_ts DESC LIMIT ?2",
            )
            .map_err(internal)?;
        let rows = stmt
            .query_map(params![p.project, limit], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(internal)?;
        let mut s = String::new();
        let mut n = 0;
        for row in rows {
            let (id, project, title, last_ts, msgs) = row.map_err(internal)?;
            n += 1;
            let day = last_ts.get(..10).unwrap_or("");
            s.push_str(&format!(
                "{n}. [{day}] {project} · {title} ({msgs} msgs, session_id={id})\n"
            ));
        }
        if n == 0 {
            s.push_str("No sessions indexed yet — run `session-brain index` first.");
        }
        Ok(CallToolResult::success(vec![Content::text(s)]))
    }
}

#[tool_handler]
impl ServerHandler for SessionBrainServer {
    fn get_info(&self) -> ServerInfo {
        let mut who = Implementation::from_build_env();
        who.name = "session-brain".to_string();
        who.version = env!("CARGO_PKG_VERSION").to_string();
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(who)
            .with_protocol_version(ProtocolVersion::V_2024_11_05)
            .with_instructions(
                "Local index of the user's Claude Code session history (long-term memory). \
                 Start with sessions_search (hybrid lexical+semantic); read full context with \
                 sessions_get; sessions_recent lists the latest sessions."
                    .to_string(),
            )
    }
}

pub fn serve(db_path: PathBuf) -> Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async {
        let service = SessionBrainServer::new(db_path).serve(stdio()).await?;
        service.waiting().await?;
        Ok::<(), anyhow::Error>(())
    })
}
