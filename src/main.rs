mod db;
mod export;
mod mcp;
mod ollama;
mod parser;
mod search;
mod serve;

use anyhow::Result;
use clap::{Parser, Subcommand};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

#[derive(Parser)]
#[command(
    name = "session-brain",
    version,
    about = "Index and search Claude Code session history (SQLite + FTS5)"
)]
struct Cli {
    /// Path to the index database (default: ~/.session-brain/index.db)
    #[arg(long, global = true)]
    db: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Scan ~/.claude/projects and (re)index new or changed session files
    Index {
        /// Re-index everything, ignoring the incremental cache
        #[arg(long)]
        full: bool,
        /// Root directory to scan (default: ~/.claude/projects)
        #[arg(long)]
        root: Option<PathBuf>,
    },
    /// Full-text search across all indexed sessions
    Search {
        /// Query terms (prefix-matched; quotes/OR/NOT/* pass through as raw FTS5)
        query: Vec<String>,
        /// Filter by project dir name or cwd substring
        #[arg(short, long)]
        project: Option<String>,
        /// Filter by role (user|assistant)
        #[arg(short, long)]
        role: Option<String>,
        /// Max results
        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,
        /// Include subagent/workflow transcripts (excluded by default)
        #[arg(short, long)]
        all: bool,
        /// Add a semantic (embedding) pass, fused with FTS via RRF.
        /// Requires `embed` to have been run and Ollama to be up.
        #[arg(short, long)]
        semantic: bool,
        /// Embedding model (must match the one used by `embed`)
        #[arg(long, default_value = "qwen3-embedding:8b")]
        model: String,
        /// Ollama base URL
        #[arg(long, default_value = "http://localhost:11434")]
        url: String,
    },
    /// Batch job: embed indexed messages with a local LLM (Ollama).
    /// Incremental — skips chunks whose content hash is already embedded.
    Embed {
        /// Embedding model name in Ollama
        #[arg(long, default_value = "qwen3-embedding:8b")]
        model: String,
        /// Ollama base URL
        #[arg(long, default_value = "http://localhost:11434")]
        url: String,
        /// Chunks per Ollama request
        #[arg(long, default_value_t = 32)]
        batch: usize,
    },
    /// Export session notes to an Obsidian vault (regenerates Sessions/,
    /// Projects/ and Home.md — treat those as read-only derived views)
    Export {
        /// Vault directory (default: ~/Obsidian/SessionBrain)
        #[arg(long)]
        vault: Option<PathBuf>,
    },
    /// Run as an MCP server over stdio.
    /// Register with: claude mcp add session-brain -s user -- session-brain mcp
    Mcp,
    /// Run the local web UI (session list, transcript/branch viewer, search)
    Serve {
        /// Port to listen on (localhost only)
        #[arg(long, default_value_t = 7777)]
        port: u16,
    },
    /// Show a session transcript by session id (prefix ok)
    Show {
        session: String,
        /// Max characters printed per message
        #[arg(long, default_value_t = 600)]
        width: usize,
    },
    /// Index statistics
    Stats,
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .expect("cannot determine home directory")
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let db_path = cli
        .db
        .unwrap_or_else(|| home_dir().join(".session-brain").join("index.db"));
    if matches!(cli.cmd, Cmd::Mcp) {
        return mcp::serve(db_path);
    }
    if let Cmd::Serve { port } = &cli.cmd {
        return serve::serve(db_path, *port);
    }
    let conn = db::open(&db_path)?;
    match cli.cmd {
        Cmd::Mcp | Cmd::Serve { .. } => unreachable!(),
        Cmd::Index { full, root } => cmd_index(&conn, full, root),
        Cmd::Search {
            query,
            project,
            role,
            limit,
            all,
            semantic,
            model,
            url,
        } => cmd_search(
            &conn,
            &query.join(" "),
            project,
            role,
            limit,
            all,
            semantic,
            &model,
            &url,
        ),
        Cmd::Embed { model, url, batch } => cmd_embed(&conn, &model, &url, batch),
        Cmd::Export { vault } => {
            let vault =
                vault.unwrap_or_else(|| home_dir().join("Obsidian").join("SessionBrain"));
            export::run(&conn, &vault)
        }
        Cmd::Show { session, width } => cmd_show(&conn, &session, width),
        Cmd::Stats => cmd_stats(&conn),
    }
}

#[derive(Default)]
struct IndexStats {
    files_indexed: usize,
    files_skipped: usize,
    sessions: usize,
    messages: usize,
    parse_errors: usize,
}

fn cmd_index(conn: &Connection, full: bool, root: Option<PathBuf>) -> Result<()> {
    let root = root.unwrap_or_else(|| home_dir().join(".claude").join("projects"));
    anyhow::ensure!(root.is_dir(), "projects root not found: {}", root.display());
    let started = Instant::now();
    let mut st = IndexStats::default();

    let mut project_dirs: Vec<PathBuf> = fs::read_dir(&root)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    project_dirs.sort();

    for pdir in project_dirs {
        let project = pdir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let mut files: Vec<PathBuf> = Vec::new();
        collect_jsonl(&pdir, &mut files)?;
        files.sort();

        for fpath in files {
            // Layout: <project>/<session>.jsonl are main sessions;
            // <project>/<session-id>/subagents/**.jsonl are subagent transcripts.
            let rel: Vec<String> = fpath
                .strip_prefix(&pdir)
                .unwrap_or(&fpath)
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect();
            let (kind, parent_id, forced_sid) = if rel.len() <= 1 {
                ("main", None, None)
            } else {
                (
                    "subagent",
                    Some(rel[0].clone()),
                    Some(
                        fpath
                            .file_stem()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string(),
                    ),
                )
            };
            let meta = fs::metadata(&fpath)?;
            let mtime = meta
                .modified()?
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let size = meta.len() as i64;
            let key = fpath.to_string_lossy().to_string();
            if !full && db::file_unchanged(conn, &key, mtime, size)? {
                st.files_skipped += 1;
                continue;
            }
            match index_file(
                conn, &project, &fpath, mtime, size, kind, &parent_id, &forced_sid,
            ) {
                Ok((sess, msgs, errs)) => {
                    st.files_indexed += 1;
                    st.sessions += sess;
                    st.messages += msgs;
                    st.parse_errors += errs;
                }
                Err(e) => eprintln!("warn: failed to index {}: {e:#}", fpath.display()),
            }
        }
    }
    println!(
        "indexed {} files ({} unchanged skipped), {} sessions, {} messages, {} unparsable lines in {:.1}s",
        st.files_indexed,
        st.files_skipped,
        st.sessions,
        st.messages,
        st.parse_errors,
        started.elapsed().as_secs_f32()
    );
    Ok(())
}

#[derive(Default)]
struct SessMeta {
    title: Option<String>,
    cwd: Option<String>,
    git_branch: Option<String>,
    first_ts: Option<String>,
    last_ts: Option<String>,
    user_msgs: i64,
    assistant_msgs: i64,
}

/// Recursively collect .jsonl files under a directory.
fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let p = entry.path();
        if p.is_dir() {
            collect_jsonl(&p, out)?;
        } else if p
            .extension()
            .map_or(false, |x| x.eq_ignore_ascii_case("jsonl"))
        {
            out.push(p);
        }
    }
    Ok(())
}

/// Index one JSONL file inside a transaction.
/// Returns (sessions, messages, unparsable lines).
#[allow(clippy::too_many_arguments)]
fn index_file(
    conn: &Connection,
    project: &str,
    path: &Path,
    mtime: i64,
    size: i64,
    kind: &str,
    parent_id: &Option<String>,
    forced_sid: &Option<String>,
) -> Result<(usize, usize, usize)> {
    let key = path.to_string_lossy().to_string();
    let fallback_sid = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let tx = conn.unchecked_transaction()?;
    db::delete_file_data(&tx, &key)?;

    let mut sessions: HashMap<String, SessMeta> = HashMap::new();
    let mut n_msgs = 0usize;
    let mut n_errs = 0usize;
    {
        let mut ins = tx.prepare(
            "INSERT INTO messages (session_id, uuid, ts, role, model, is_sidechain, line_no, kind, content)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        )?;
        let mut ins_link = tx.prepare(
            "INSERT OR REPLACE INTO links (uuid, session_id, parent_uuid, line_no, role)
             VALUES (?1,?2,?3,?4,?5)",
        )?;
        let reader = BufReader::new(fs::File::open(path)?);
        for (i, line) in reader.lines().enumerate() {
            let line = match line {
                Ok(l) => l,
                Err(_) => {
                    n_errs += 1;
                    continue;
                }
            };
            let line = line.trim_start_matches('\u{feff}');
            if line.trim().is_empty() {
                continue;
            }
            let raw: parser::RawLine = match serde_json::from_str(line) {
                Ok(r) => r,
                Err(_) => {
                    n_errs += 1;
                    continue;
                }
            };
            let sid = match forced_sid {
                Some(s) => s.clone(),
                None => raw
                    .session_id
                    .clone()
                    .unwrap_or_else(|| fallback_sid.clone()),
            };
            let m = sessions.entry(sid.clone()).or_default();
            if let Some(ts) = &raw.timestamp {
                if m.first_ts.as_deref().map_or(true, |f| ts.as_str() < f) {
                    m.first_ts = Some(ts.clone());
                }
                if m.last_ts.as_deref().map_or(true, |l| ts.as_str() > l) {
                    m.last_ts = Some(ts.clone());
                }
            }
            if raw.cwd.is_some() {
                m.cwd = raw.cwd.clone();
            }
            if raw.git_branch.is_some() {
                m.git_branch = raw.git_branch.clone();
            }
            match raw.kind.as_deref() {
                Some("ai-title") => {
                    if raw.ai_title.is_some() {
                        m.title = raw.ai_title.clone();
                    }
                }
                Some("summary") => {
                    if m.title.is_none() {
                        m.title = raw.summary.clone();
                    }
                }
                Some(role) if role == "user" || role == "assistant" => {
                    // Record parent linkage for EVERY line with a uuid — even
                    // tool steps we don't index as content. The branch tree
                    // needs the complete chain.
                    if let Some(u) = &raw.uuid {
                        ins_link.execute(params![
                            u,
                            sid,
                            raw.parent_uuid,
                            (i + 1) as i64,
                            role
                        ])?;
                    }
                    let Some(msg) = &raw.message else { continue };
                    let Some(text) = parser::extract_text(&msg.content) else {
                        // Thinking-only lines: stored with kind='thinking' so the
                        // web UI can show them collapsed. Not counted as messages.
                        if let Some(think) = parser::extract_thinking(&msg.content) {
                            ins.execute(params![
                                sid,
                                raw.uuid,
                                raw.timestamp,
                                role,
                                msg.model,
                                raw.is_sidechain as i64,
                                (i + 1) as i64,
                                "thinking",
                                think
                            ])?;
                        } else if let Some(tool) = parser::extract_tool_summary(&msg.content) {
                            ins.execute(params![
                                sid,
                                raw.uuid,
                                raw.timestamp,
                                role,
                                msg.model,
                                raw.is_sidechain as i64,
                                (i + 1) as i64,
                                "tool",
                                tool
                            ])?;
                        }
                        continue;
                    };
                    if role == "user" && parser::is_noise(&text) {
                        continue;
                    }
                    ins.execute(params![
                        sid,
                        raw.uuid,
                        raw.timestamp,
                        role,
                        msg.model,
                        raw.is_sidechain as i64,
                        (i + 1) as i64,
                        "text",
                        text
                    ])?;
                    if role == "user" {
                        m.user_msgs += 1;
                    } else {
                        m.assistant_msgs += 1;
                    }
                    n_msgs += 1;
                }
                _ => {}
            }
        }
    }

    for (sid, m) in &sessions {
        tx.execute(
            "INSERT INTO sessions
               (id, project, path, kind, parent_id, title, cwd, git_branch,
                first_ts, last_ts, user_msgs, assistant_msgs)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(id) DO UPDATE SET
               project = excluded.project,
               path = excluded.path,
               kind = excluded.kind,
               parent_id = excluded.parent_id,
               title = COALESCE(excluded.title, sessions.title),
               cwd = excluded.cwd,
               git_branch = excluded.git_branch,
               first_ts = excluded.first_ts,
               last_ts = excluded.last_ts,
               user_msgs = excluded.user_msgs,
               assistant_msgs = excluded.assistant_msgs",
            params![
                sid,
                project,
                key,
                kind,
                parent_id,
                m.title,
                m.cwd,
                m.git_branch,
                m.first_ts,
                m.last_ts,
                m.user_msgs,
                m.assistant_msgs
            ],
        )?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?1,?2,?3)",
        params![key, mtime, size],
    )?;
    tx.commit()?;
    Ok((sessions.len(), n_msgs, n_errs))
}

#[allow(clippy::too_many_arguments)]
fn cmd_search(
    conn: &Connection,
    query: &str,
    project: Option<String>,
    role: Option<String>,
    limit: usize,
    all: bool,
    semantic: bool,
    model: &str,
    url: &str,
) -> Result<()> {
    let out = search::run_search(
        conn,
        &search::SearchOpts {
            query,
            project,
            role,
            limit,
            all,
            semantic,
            model,
            url,
        },
    )?;
    if let Some(note) = &out.semantic_note {
        eprintln!("warn: {note}");
    }
    if out.hits.is_empty() {
        println!("no matches for: {query}");
        return Ok(());
    }
    for (i, h) in out.hits.iter().take(limit).enumerate() {
        let short: String = h.sid.chars().take(8).collect();
        let day = h.ts.get(..10).unwrap_or("");
        let title = if h.title.is_empty() {
            "(untitled)"
        } else {
            &h.title
        };
        let mark = if h.kind == "subagent" { " · sub" } else { "" };
        println!(
            "{:2}. [{day}] {} · {title} ({short}, {}{mark})",
            i + 1,
            h.proj,
            h.role
        );
        println!("    {}", h.snip.replace('\n', " "));
    }
    if out.scan_total as usize > out.hits.len().min(limit) {
        println!();
        println!(
            "note: {} literal matches in total, showing {} — narrow with -p/--project or raise -n",
            out.scan_total,
            out.hits.len().min(limit)
        );
    }
    Ok(())
}

const CHUNK_MAX_CHARS: usize = 2000;
const MIN_EMBED_CHARS: usize = 12;

/// Split text into embedding-sized chunks at paragraph boundaries.
fn chunk_text(text: &str) -> Vec<String> {
    fn flush(chunks: &mut Vec<String>, cur: &mut String) {
        let t = cur.trim();
        if !t.is_empty() {
            chunks.push(t.to_string());
        }
        cur.clear();
    }
    if text.chars().count() <= CHUNK_MAX_CHARS {
        let t = text.trim();
        return if t.is_empty() {
            Vec::new()
        } else {
            vec![t.to_string()]
        };
    }
    let mut chunks = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0usize;
    for para in text.split("\n\n") {
        let plen = para.chars().count();
        if plen > CHUNK_MAX_CHARS {
            flush(&mut chunks, &mut cur);
            cur_len = 0;
            let cs: Vec<char> = para.chars().collect();
            for piece in cs.chunks(CHUNK_MAX_CHARS) {
                let s: String = piece.iter().collect();
                let s = s.trim().to_string();
                if !s.is_empty() {
                    chunks.push(s);
                }
            }
            continue;
        }
        if cur_len > 0 && cur_len + plen > CHUNK_MAX_CHARS {
            flush(&mut chunks, &mut cur);
            cur_len = 0;
        }
        if cur_len > 0 {
            cur.push_str("\n\n");
            cur_len += 2;
        }
        cur.push_str(para);
        cur_len += plen;
    }
    flush(&mut chunks, &mut cur);
    chunks
}

fn hash_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Batch job: embed every indexed message chunk that isn't embedded yet.
/// Incremental by content hash; safe to re-run any time (also after
/// `index --full`, which does NOT invalidate vectors).
fn cmd_embed(conn: &Connection, model: &str, url: &str, batch: usize) -> Result<()> {
    let started = Instant::now();
    let orphans = conn.execute(
        "DELETE FROM vectors WHERE message_uuid NOT IN
           (SELECT uuid FROM messages WHERE uuid IS NOT NULL)",
        [],
    )?;
    if orphans > 0 {
        println!("removed {orphans} orphaned vectors");
    }

    struct Job {
        uuid: String,
        seq: i64,
        hash: String,
        text: String,
    }
    let mut jobs: Vec<Job> = Vec::new();
    let mut msgs_total = 0usize;
    let mut msgs_todo = 0usize;
    {
        let mut stmt =
            conn.prepare("SELECT uuid, content FROM messages WHERE uuid IS NOT NULL AND kind = 'text'")?;
        let mut existing_stmt = conn.prepare(
            "SELECT seq, content_hash FROM vectors
             WHERE message_uuid = ?1 AND model = ?2 ORDER BY seq",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (uuid, content) = row?;
            msgs_total += 1;
            // Very short texts embed into near-generic vectors and pollute
            // semantic results with spurious matches — don't embed them.
            let chunks: Vec<String> = chunk_text(&content)
                .into_iter()
                .filter(|c| c.chars().count() >= MIN_EMBED_CHARS)
                .collect();
            if chunks.is_empty() {
                conn.execute(
                    "DELETE FROM vectors WHERE message_uuid = ?1 AND model = ?2",
                    params![uuid, model],
                )?;
                continue;
            }
            let hashes: Vec<String> = chunks.iter().map(|c| hash_hex(c)).collect();
            let existing: Vec<(i64, String)> = existing_stmt
                .query_map(params![uuid, model], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<_, _>>()?;
            let up_to_date = existing.len() == chunks.len()
                && existing
                    .iter()
                    .enumerate()
                    .all(|(i, (s, h))| *s == i as i64 && h == &hashes[i]);
            if up_to_date {
                continue;
            }
            msgs_todo += 1;
            conn.execute(
                "DELETE FROM vectors WHERE message_uuid = ?1 AND model = ?2",
                params![uuid, model],
            )?;
            for (i, (c, h)) in chunks.into_iter().zip(hashes).enumerate() {
                jobs.push(Job {
                    uuid: uuid.clone(),
                    seq: i as i64,
                    hash: h,
                    text: c,
                });
            }
        }
    }
    println!(
        "{msgs_total} messages scanned, {msgs_todo} need embedding ({} chunks) [model: {model}]",
        jobs.len()
    );
    if jobs.is_empty() {
        return Ok(());
    }

    let mut done = 0usize;
    for group in jobs.chunks(batch.max(1)) {
        let inputs: Vec<String> = group.iter().map(|j| j.text.clone()).collect();
        let vecs = ollama::embed_batch(url, model, &inputs)?;
        let tx = conn.unchecked_transaction()?;
        {
            let mut ins = tx.prepare(
                "INSERT OR REPLACE INTO vectors
                   (message_uuid, seq, model, content_hash, dim, embedding, text)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
            )?;
            for (j, v) in group.iter().zip(vecs.iter()) {
                let blob: Vec<u8> = v.iter().flat_map(|f| f.to_le_bytes()).collect();
                ins.execute(params![
                    j.uuid,
                    j.seq,
                    model,
                    j.hash,
                    v.len() as i64,
                    blob,
                    j.text
                ])?;
            }
        }
        tx.commit()?;
        done += group.len();
        println!(
            "  embedded {done}/{} chunks ({:.0}s elapsed)",
            jobs.len(),
            started.elapsed().as_secs_f32()
        );
    }
    println!("done in {:.1}s", started.elapsed().as_secs_f32());
    Ok(())
}

fn cmd_show(conn: &Connection, session: &str, width: usize) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, project, COALESCE(title,'(untitled)'), COALESCE(cwd,'?'),
                COALESCE(first_ts,''), COALESCE(last_ts,'')
         FROM sessions WHERE id LIKE ?1||'%' LIMIT 2",
    )?;
    let hits: Vec<(String, String, String, String, String, String)> = stmt
        .query_map(params![session], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?
        .collect::<std::result::Result<_, _>>()?;
    anyhow::ensure!(!hits.is_empty(), "no session matching '{session}'");
    anyhow::ensure!(
        hits.len() == 1,
        "ambiguous prefix '{session}' — give more characters"
    );
    let (id, project, title, cwd, first, last) = &hits[0];
    println!("session : {id}");
    println!("project : {project}");
    println!("title   : {title}");
    println!("cwd     : {cwd}");
    println!("span    : {first} → {last}");
    println!("resume  : claude --resume {id}   (run inside {cwd})");
    println!();

    let mut stmt = conn.prepare(
        "SELECT role, COALESCE(ts,''), content
         FROM messages WHERE session_id = ?1 ORDER BY line_no",
    )?;
    let rows = stmt.query_map(params![id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (role, ts, content) = row?;
        let mut text: String = content.chars().take(width).collect();
        if text.len() < content.len() {
            text.push('…');
        }
        println!("── {role} [{ts}] ──");
        println!("{text}");
        println!();
    }
    Ok(())
}

fn cmd_stats(conn: &Connection) -> Result<()> {
    let sessions: i64 = conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))?;
    let messages: i64 = conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))?;
    let files: i64 = conn.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))?;
    let (min_ts, max_ts): (Option<String>, Option<String>) = conn.query_row(
        "SELECT MIN(first_ts), MAX(last_ts) FROM sessions",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let subagents: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sessions WHERE kind = 'subagent'",
        [],
        |r| r.get(0),
    )?;
    let vectors: i64 = conn.query_row("SELECT COUNT(*) FROM vectors", [], |r| r.get(0))?;
    println!("files    : {files}");
    println!("sessions : {} main + {subagents} subagent", sessions - subagents);
    println!("messages : {messages}");
    println!("vectors  : {vectors}");
    println!(
        "span     : {} → {}",
        min_ts.as_deref().unwrap_or("-"),
        max_ts.as_deref().unwrap_or("-")
    );
    println!();
    println!("top projects (by messages):");
    let mut stmt = conn.prepare(
        "SELECT project, COUNT(*), SUM(user_msgs + assistant_msgs)
         FROM sessions GROUP BY project ORDER BY 3 DESC LIMIT 15",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    for row in rows {
        let (project, sess, msgs) = row?;
        println!("  {msgs:>7} msgs / {sess:>3} sessions  {project}");
    }
    Ok(())
}
