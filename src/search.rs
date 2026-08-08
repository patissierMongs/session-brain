//! Multi-pass hybrid search: FTS5 (bm25-ranked) + optional semantic pass
//! (local-LLM embeddings, cosine) fused via RRF, plus a literal substring
//! scan for full recall. Shared by the CLI and the MCP server.

use crate::ollama;
use anyhow::Result;
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

pub struct Hit {
    pub rowid: i64,
    pub proj: String,
    pub title: String,
    pub sid: String,
    pub role: String,
    pub ts: String,
    pub snip: String,
    pub kind: String,
}

pub struct SearchOpts<'a> {
    pub query: &'a str,
    pub project: Option<String>,
    pub role: Option<String>,
    pub limit: usize,
    pub all: bool,
    pub semantic: bool,
    pub model: &'a str,
    pub url: &'a str,
}

pub struct SearchOutcome {
    pub hits: Vec<Hit>,
    /// Total literal substring matches (may exceed hits shown).
    pub scan_total: i64,
    /// Set when a requested semantic pass could not run (degraded to lexical).
    pub semantic_note: Option<String>,
}

/// Turn a plain query into FTS5 syntax: each term becomes a quoted prefix
/// match ("term"*), which handles Korean particles and partial identifiers.
/// Queries that already use FTS5 operators pass through untouched.
fn build_match(q: &str) -> String {
    let raw = q.trim();
    let has_ops = raw.contains('"')
        || raw.contains('*')
        || raw
            .split_whitespace()
            .any(|w| matches!(w, "OR" | "AND" | "NOT" | "NEAR"));
    if has_ops {
        return raw.to_string();
    }
    raw.split_whitespace()
        .map(|w| format!("\"{}\"*", w.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn run_search(conn: &Connection, o: &SearchOpts) -> Result<SearchOutcome> {
    anyhow::ensure!(!o.query.trim().is_empty(), "empty query");

    // Pass 1: FTS5, bm25-ranked (fast, relevance-ordered).
    let m = build_match(o.query);
    let mut fts_hits: Vec<Hit> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT m.id, s.project, COALESCE(s.title,''), s.id, m.role, COALESCE(m.ts,''),
                    snippet(messages_fts, 0, '[', ']', ' … ', 24), s.kind
             FROM messages_fts
             JOIN messages m ON m.id = messages_fts.rowid
             JOIN sessions s ON s.id = m.session_id
             WHERE messages_fts MATCH ?1
               AND m.kind = 'text'
               AND (?2 IS NULL OR s.project LIKE '%'||?2||'%' OR COALESCE(s.cwd,'') LIKE '%'||?2||'%')
               AND (?3 IS NULL OR m.role = ?3)
               AND (?5 = 1 OR s.kind = 'main')
             ORDER BY bm25(messages_fts)
             LIMIT ?4",
        )?;
        let rows = stmt.query_map(
            params![m, o.project, o.role, (o.limit * 2) as i64, o.all as i64],
            |r| {
                Ok(Hit {
                    rowid: r.get(0)?,
                    proj: r.get(1)?,
                    title: r.get(2)?,
                    sid: r.get(3)?,
                    role: r.get(4)?,
                    ts: r.get(5)?,
                    snip: r.get(6)?,
                    kind: r.get(7)?,
                })
            },
        )?;
        for h in rows {
            fts_hits.push(h?);
        }
    }

    // Pass 2 (optional): semantic. Failure degrades gracefully to lexical.
    let mut sem_hits: Vec<Hit> = Vec::new();
    let mut semantic_note: Option<String> = None;
    if o.semantic {
        match semantic_pass(conn, o) {
            Ok(h) => sem_hits = h,
            Err(e) => semantic_note = Some(format!("semantic pass skipped: {e:#}")),
        }
    }

    let ordered: Vec<Hit> = if sem_hits.is_empty() {
        fts_hits
    } else {
        rrf_merge(vec![fts_hits, sem_hits])
    };
    let mut hits: Vec<Hit> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    for h in ordered {
        if seen.insert(h.rowid) {
            hits.push(h);
        }
    }

    // Pass 3: literal substring scan — full recall. Catches matches inside
    // Korean compounds and identifiers that token/prefix matching misses.
    // Skipped when the query uses raw FTS5 operators.
    let has_ops = o.query.contains('"')
        || o.query.contains('*')
        || o.query
            .split_whitespace()
            .any(|w| matches!(w, "OR" | "AND" | "NOT" | "NEAR"));
    let terms: Vec<String> = o.query.split_whitespace().map(String::from).collect();
    let mut scan_total: i64 = 0;
    if !has_ops && !terms.is_empty() {
        let mut where_sql = String::from(
            " FROM messages m
             JOIN sessions s ON s.id = m.session_id
             WHERE m.kind = 'text'
               AND (?1 IS NULL OR s.project LIKE '%'||?1||'%' OR COALESCE(s.cwd,'') LIKE '%'||?1||'%')
               AND (?2 IS NULL OR m.role = ?2)
               AND (?3 = 1 OR s.kind = 'main')",
        );
        for i in 0..terms.len() {
            where_sql.push_str(&format!(
                " AND m.content LIKE '%'||?{}||'%' ESCAPE '\\'",
                i + 4
            ));
        }
        let escaped: Vec<String> = terms
            .iter()
            .map(|t| {
                t.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            })
            .collect();
        let all_i = o.all as i64;
        let scan_limit = (o.limit * 2) as i64;
        let mut pv: Vec<&dyn rusqlite::ToSql> = vec![&o.project, &o.role, &all_i];
        for e in &escaped {
            pv.push(e);
        }

        // Honest truncation: report how many literal matches exist in total.
        let count_sql = format!("SELECT COUNT(*){where_sql}");
        scan_total = conn.query_row(&count_sql, &pv[..], |r| r.get(0))?;

        let sql = format!(
            "SELECT m.id, s.project, COALESCE(s.title,''), s.id, m.role, COALESCE(m.ts,''),
                    m.content, s.kind{where_sql} ORDER BY m.ts DESC LIMIT ?{}",
            terms.len() + 4
        );
        pv.push(&scan_limit);

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(&pv[..], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        })?;
        for row in rows {
            let (rowid, proj, title, sid, mrole, ts, content, kind) = row?;
            if !seen.insert(rowid) {
                continue;
            }
            hits.push(Hit {
                rowid,
                proj,
                title,
                sid,
                role: mrole,
                ts,
                snip: excerpt(&content, &terms),
                kind,
            });
            if hits.len() >= o.limit {
                break;
            }
        }
    }

    Ok(SearchOutcome {
        hits,
        scan_total,
        semantic_note,
    })
}

/// Embed the query, cosine against stored vectors, best chunk per message,
/// ranked by similarity. Requires vectors (see `embed`) and a running Ollama.
fn semantic_pass(conn: &Connection, o: &SearchOpts) -> Result<Vec<Hit>> {
    let nvec: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vectors WHERE model = ?1",
        params![o.model],
        |r| r.get(0),
    )?;
    anyhow::ensure!(
        nvec > 0,
        "no vectors for model '{}' — run `session-brain embed` first",
        o.model
    );
    let qv = ollama::embed_batch(o.url, o.model, &[o.query.to_string()])?
        .into_iter()
        .next()
        .unwrap_or_default();
    anyhow::ensure!(!qv.is_empty(), "empty query embedding from Ollama");

    let mut stmt = conn.prepare(
        "SELECT m.id, s.project, COALESCE(s.title,''), s.id, m.role, COALESCE(m.ts,''),
                v.text, s.kind, v.embedding
         FROM vectors v
         JOIN messages m ON m.uuid = v.message_uuid
         JOIN sessions s ON s.id = m.session_id
         WHERE v.model = ?4
           AND m.kind = 'text'
           AND (?1 IS NULL OR s.project LIKE '%'||?1||'%' OR COALESCE(s.cwd,'') LIKE '%'||?1||'%')
           AND (?2 IS NULL OR m.role = ?2)
           AND (?3 = 1 OR s.kind = 'main')",
    )?;
    let rows = stmt.query_map(params![o.project, o.role, o.all as i64, o.model], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, Vec<u8>>(8)?,
        ))
    })?;
    let mut best: HashMap<i64, (f32, Hit)> = HashMap::new();
    for row in rows {
        let (rowid, proj, title, sid, mrole, ts, text, kind, blob) = row?;
        let v: Vec<f32> = blob
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        let score = cosine(&qv, &v);
        let replace = match best.get(&rowid) {
            Some((s, _)) => score > *s,
            None => true,
        };
        if replace {
            let snip: String = text.chars().take(150).collect();
            best.insert(
                rowid,
                (
                    score,
                    Hit {
                        rowid,
                        proj,
                        title,
                        sid,
                        role: mrole,
                        ts,
                        snip: format!("(≈{score:.2}) {snip}"),
                        kind,
                    },
                ),
            );
        }
    }
    let mut scored: Vec<(f32, Hit)> = best.into_values().collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(scored.into_iter().take(o.limit * 2).map(|(_, h)| h).collect())
}

/// Build a ±60-char excerpt around the first occurrence of any term
/// (ASCII case-insensitive), highlighting it with [ ].
fn excerpt(content: &str, terms: &[String]) -> String {
    // ASCII-only lowercasing preserves byte offsets (1 byte -> 1 byte).
    let hay: String = content.chars().map(|c| c.to_ascii_lowercase()).collect();
    let mut best: Option<(usize, usize)> = None;
    for t in terms {
        let needle: String = t.chars().map(|c| c.to_ascii_lowercase()).collect();
        if let Some(pos) = hay.find(&needle) {
            if best.map_or(true, |(b, _)| pos < b) {
                best = Some((pos, needle.len()));
            }
        }
    }
    let Some((pos, len)) = best else {
        return content.chars().take(120).collect();
    };
    let mut start = pos.saturating_sub(60);
    while start > 0 && !content.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (pos + len + 60).min(content.len());
    while end < content.len() && !content.is_char_boundary(end) {
        end += 1;
    }
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(&content[start..pos]);
    out.push('[');
    out.push_str(&content[pos..pos + len]);
    out.push(']');
    out.push_str(&content[pos + len..end]);
    if end < content.len() {
        out.push('…');
    }
    out
}

/// Reciprocal Rank Fusion over ranked lists (k = 60).
fn rrf_merge(lists: Vec<Vec<Hit>>) -> Vec<Hit> {
    let mut score: HashMap<i64, f64> = HashMap::new();
    let mut store: HashMap<i64, Hit> = HashMap::new();
    for list in lists {
        for (rank, h) in list.into_iter().enumerate() {
            *score.entry(h.rowid).or_default() += 1.0 / (60.0 + rank as f64 + 1.0);
            store.entry(h.rowid).or_insert(h);
        }
    }
    let mut rowids: Vec<i64> = store.keys().copied().collect();
    rowids.sort_by(|a, b| {
        score[b]
            .partial_cmp(&score[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rowids
        .into_iter()
        .filter_map(|id| store.remove(&id))
        .collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let (mut dot, mut na, mut nb) = (0f32, 0f32, 0f32);
    for i in 0..n {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}
