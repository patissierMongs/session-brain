//! SQLite storage. Principle: the JSONL files are the source of truth;
//! this DB is a disposable cache that can always be rebuilt with `index --full`.

use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::Path;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS files (
    path  TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    size  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    project    TEXT NOT NULL,
    path       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'main',
    parent_id  TEXT,
    title      TEXT,
    cwd        TEXT,
    git_branch TEXT,
    first_ts   TEXT,
    last_ts    TEXT,
    user_msgs      INTEGER NOT NULL DEFAULT 0,
    assistant_msgs INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_path ON sessions(path);

CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY,
    session_id   TEXT NOT NULL,
    uuid         TEXT,
    ts           TEXT,
    role         TEXT NOT NULL,
    model        TEXT,
    is_sidechain INTEGER NOT NULL DEFAULT 0,
    line_no      INTEGER NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'text',
    content      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
END;

-- Full parent linkage for EVERY message line (including tool steps that we
-- don't index as content) — needed to reconstruct the branch tree exactly.
CREATE TABLE IF NOT EXISTS links (
    uuid        TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    parent_uuid TEXT,
    line_no     INTEGER NOT NULL,
    role        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_session ON links(session_id);

-- Semantic layer. Keyed by message uuid (stable across reindex — message
-- rowids are NOT stable) + content hash (skip re-embedding on rebuilds).
-- Deliberately not touched by delete_file_data; orphans are cleaned up by
-- the `embed` command.
CREATE TABLE IF NOT EXISTS vectors (
    message_uuid TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    model        TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    dim          INTEGER NOT NULL,
    embedding    BLOB NOT NULL,
    text         TEXT NOT NULL,
    PRIMARY KEY (message_uuid, seq, model)
);
"#;

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.execute_batch(SCHEMA)?;
    // Migration for DBs created before the `kind` column existed.
    let _ = conn.execute(
        "ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'",
        [],
    );
    Ok(conn)
}

pub fn file_unchanged(conn: &Connection, path: &str, mtime: i64, size: i64) -> Result<bool> {
    let row: Option<(i64, i64)> = conn
        .query_row(
            "SELECT mtime, size FROM files WHERE path = ?1",
            params![path],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    Ok(matches!(row, Some((m, s)) if m == mtime && s == size))
}

/// Remove everything previously indexed from this file.
/// FTS rows are cleaned up by the delete trigger.
pub fn delete_file_data(conn: &Connection, path: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE path = ?1)",
        params![path],
    )?;
    conn.execute(
        "DELETE FROM links WHERE session_id IN (SELECT id FROM sessions WHERE path = ?1)",
        params![path],
    )?;
    conn.execute("DELETE FROM sessions WHERE path = ?1", params![path])?;
    conn.execute("DELETE FROM files WHERE path = ?1", params![path])?;
    Ok(())
}
