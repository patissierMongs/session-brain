//! Local web UI (axum): session list, transcript/branch viewer, search.
//! Serves the embedded SPA at / and JSON APIs under /api/*.
//! On-demand, localhost-only — not a background daemon.

use crate::db;
use crate::ollama;
use crate::search::{run_search, SearchOpts};
use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Path as AxPath, Query, State},
    http::StatusCode,
    response::Html,
    routing::get,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

const APP_HTML: &str = include_str!("../assets/app.html");

type AppState = Arc<PathBuf>;
type ApiError = (StatusCode, String);

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}"))
}

pub fn serve(db_path: PathBuf, port: u16) -> Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async move {
        let state: AppState = Arc::new(db_path);
        let app = Router::new()
            .route("/", get(|| async { Html(APP_HTML) }))
            .route("/api/sessions", get(api_sessions))
            .route("/api/session/{id}", get(api_session))
            .route("/api/search", get(api_search))
            .with_state(state);
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let listener = tokio::net::TcpListener::bind(addr).await?;
        println!("session-brain web UI → http://localhost:{port}/");
        axum::serve(listener, app).await?;
        Ok::<(), anyhow::Error>(())
    })
}

/// Derive a human project name from cwd (last path component).
fn project_name(cwd: &str, project_dir: &str) -> String {
    let base = cwd
        .replace('/', "\\")
        .split('\\')
        .filter(|s| !s.is_empty())
        .last()
        .map(|s| s.to_string());
    match base {
        Some(b) if !b.is_empty() => b,
        _ => project_dir.to_string(),
    }
}

async fn api_sessions(State(dbp): State<AppState>) -> Result<Json<Value>, ApiError> {
    let dbp = dbp.as_ref().clone();
    let v = tokio::task::spawn_blocking(move || -> Result<Value> {
        let conn = db::open(&dbp)?;
        let mut stmt = conn.prepare(
            "SELECT s.id, s.project, COALESCE(s.cwd,''), COALESCE(s.title,''),
                    COALESCE(s.first_ts,''), COALESCE(s.last_ts,''),
                    s.user_msgs, s.assistant_msgs,
                    (SELECT COUNT(*) FROM sessions x WHERE x.parent_id = s.id)
             FROM sessions s
             WHERE s.kind = 'main' AND s.user_msgs + s.assistant_msgs > 0
             ORDER BY s.last_ts DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            let project: String = r.get(1)?;
            let cwd: String = r.get(2)?;
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "project": project.clone(),
                "project_name": project_name(&cwd, &project),
                "title": r.get::<_, String>(3)?,
                "first_ts": r.get::<_, String>(4)?,
                "last_ts": r.get::<_, String>(5)?,
                "user_msgs": r.get::<_, i64>(6)?,
                "assistant_msgs": r.get::<_, i64>(7)?,
                "subagents": r.get::<_, i64>(8)?,
            }))
        })?;
        let arr: Vec<Value> = rows.collect::<std::result::Result<_, _>>()?;
        Ok(json!({ "sessions": arr }))
    })
    .await
    .map_err(internal)?
    .map_err(internal)?;
    Ok(Json(v))
}

async fn api_session(
    State(dbp): State<AppState>,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, ApiError> {
    let dbp = dbp.as_ref().clone();
    let v = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let conn = db::open(&dbp).map_err(internal)?;
        let cands: Vec<(String, String, String, String, String, String, String, i64, i64)> = conn
            .prepare(
                "SELECT id, project, COALESCE(cwd,''), COALESCE(title,''), COALESCE(git_branch,''),
                        COALESCE(first_ts,''), COALESCE(last_ts,''), user_msgs, assistant_msgs
                 FROM sessions WHERE id LIKE ?1||'%' LIMIT 2",
            )
            .map_err(internal)?
            .query_map(rusqlite::params![id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                ))
            })
            .map_err(internal)?
            .collect::<std::result::Result<_, _>>()
            .map_err(internal)?;
        if cands.is_empty() {
            return Err((StatusCode::NOT_FOUND, format!("no session '{id}'")));
        }
        if cands.len() > 1 {
            return Err((StatusCode::BAD_REQUEST, format!("ambiguous id '{id}'")));
        }
        let (sid, project, cwd, title, git_branch, first_ts, last_ts, um, am) = &cands[0];
        let subagents: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE parent_id = ?1",
                rusqlite::params![sid],
                |r| r.get(0),
            )
            .map_err(internal)?;

        let contents: HashMap<String, Value> = conn
            .prepare(
                "SELECT uuid, role, COALESCE(ts,''), content, kind FROM messages
                 WHERE session_id = ?1 AND uuid IS NOT NULL",
            )
            .map_err(internal)?
            .query_map(rusqlite::params![sid], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    json!({
                        "role": r.get::<_, String>(1)?,
                        "ts": r.get::<_, String>(2)?,
                        "content": r.get::<_, String>(3)?,
                        "kind": r.get::<_, String>(4)?,
                    }),
                ))
            })
            .map_err(internal)?
            .collect::<std::result::Result<_, _>>()
            .map_err(internal)?;
        let have: HashSet<&String> = contents.keys().collect();

        let links: Vec<Value> = conn
            .prepare(
                "SELECT uuid, parent_uuid, line_no, role FROM links
                 WHERE session_id = ?1 ORDER BY line_no",
            )
            .map_err(internal)?
            .query_map(rusqlite::params![sid], |r| {
                let uuid: String = r.get(0)?;
                let has = have.contains(&uuid);
                Ok(json!({
                    "uuid": uuid,
                    "parent_uuid": r.get::<_, Option<String>>(1)?,
                    "line_no": r.get::<_, i64>(2)?,
                    "role": r.get::<_, String>(3)?,
                    "has_content": has,
                }))
            })
            .map_err(internal)?
            .collect::<std::result::Result<_, _>>()
            .map_err(internal)?;

        Ok(json!({
            "meta": {
                "id": sid,
                "project": project,
                "project_name": project_name(cwd, project),
                "cwd": cwd,
                "title": title,
                "git_branch": git_branch,
                "first_ts": first_ts,
                "last_ts": last_ts,
                "user_msgs": um,
                "assistant_msgs": am,
                "subagents": subagents,
            },
            "links": links,
            "messages": contents,
        }))
    })
    .await
    .map_err(internal)??;
    Ok(Json(v))
}

async fn api_search(
    State(dbp): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let query = q.get("q").cloned().unwrap_or_default();
    if query.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "missing q".into()));
    }
    let semantic = q.get("semantic").map(|s| s != "0").unwrap_or(true);
    let project = q.get("project").filter(|s| !s.is_empty()).cloned();
    let limit: usize = q
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let include_subagents = q.get("all").map(|s| s == "1").unwrap_or(false);

    let dbp = dbp.as_ref().clone();
    let v = tokio::task::spawn_blocking(move || -> Result<Value> {
        let conn = db::open(&dbp)?;
        let model = ollama::default_model();
        let url = ollama::default_url();
        let out = run_search(
            &conn,
            &SearchOpts {
                query: &query,
                project,
                role: None,
                limit,
                all: include_subagents,
                semantic,
                model: &model,
                url: &url,
            },
        )?;
        let hits: Vec<Value> = out
            .hits
            .iter()
            .take(limit)
            .map(|h| {
                json!({
                    "session_id": h.sid,
                    "project": h.proj,
                    "title": h.title,
                    "role": h.role,
                    "ts": h.ts,
                    "snippet": h.snip,
                    "kind": h.kind,
                })
            })
            .collect();
        Ok(json!({
            "hits": hits,
            "scan_total": out.scan_total,
            "semantic_note": out.semantic_note,
        }))
    })
    .await
    .map_err(internal)?
    .map_err(internal)?;
    Ok(Json(v))
}
