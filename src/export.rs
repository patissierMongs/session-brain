//! Obsidian vault export: one note per main session + per-project MOC notes
//! + a Home index. Everything here is a READ-ONLY derived view of the index —
//! notes are regenerated wholesale on every run and must not be hand-edited.
//! Frontmatter is designed for Obsidian Bases (core plugin) dashboards.

use anyhow::Result;
use rusqlite::{params, Connection};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

struct SessionRow {
    id: String,
    project: String,
    title: String,
    cwd: String,
    git_branch: String,
    first_ts: String,
    last_ts: String,
    user_msgs: i64,
    assistant_msgs: i64,
}

/// Strip characters that break Windows filenames or Obsidian wikilinks,
/// capped at `max` chars.
fn sanitize_component(s: &str, max: usize) -> String {
    let bad: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|', '#', '^', '[', ']'];
    let mut out: String = s
        .chars()
        .map(|c| if bad.contains(&c) { ' ' } else { c })
        .collect();
    out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = out.chars().take(max).collect();
    trimmed.trim_end_matches(['.', ' ']).to_string()
}

fn sanitize_filename(s: &str) -> String {
    sanitize_component(s, 60)
}

/// Derive a human project name from cwd (last path component), falling back
/// to the encoded project dir name.
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

fn yaml_escape(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Collapse whitespace and cap at `max` chars.
fn one_line(s: &str, max: usize) -> String {
    let joined = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = joined.chars().take(max).collect();
    if out.len() < joined.len() {
        out.push('…');
    }
    out
}

pub fn run(conn: &Connection, vault: &Path) -> Result<()> {
    let sessions_dir = vault.join("Sessions");
    let projects_dir = vault.join("Projects");
    fs::create_dir_all(&sessions_dir)?;
    fs::create_dir_all(&projects_dir)?;

    // Regenerate wholesale: this vault (or at least these folders) is a
    // derived artifact. Remove previously generated notes first.
    for dir in [&sessions_dir, &projects_dir] {
        for entry in fs::read_dir(dir)? {
            let p = entry?.path();
            if p.extension().map_or(false, |x| x == "md") {
                fs::remove_file(p)?;
            }
        }
    }

    let mut stmt = conn.prepare(
        "SELECT id, project, COALESCE(title,''), COALESCE(cwd,''), COALESCE(git_branch,''),
                COALESCE(first_ts,''), COALESCE(last_ts,''), user_msgs, assistant_msgs
         FROM sessions
         WHERE kind = 'main' AND user_msgs + assistant_msgs > 0
         ORDER BY first_ts",
    )?;
    let sessions: Vec<SessionRow> = stmt
        .query_map([], |r| {
            Ok(SessionRow {
                id: r.get(0)?,
                project: r.get(1)?,
                title: r.get(2)?,
                cwd: r.get(3)?,
                git_branch: r.get(4)?,
                first_ts: r.get(5)?,
                last_ts: r.get(6)?,
                user_msgs: r.get(7)?,
                assistant_msgs: r.get(8)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;

    // project name -> Vec<(date, note name, title, msgs)>
    let mut by_project: BTreeMap<String, Vec<(String, String, String, i64)>> = BTreeMap::new();
    let mut n_notes = 0usize;

    for s in &sessions {
        let date = s.first_ts.get(..10).unwrap_or("unknown").to_string();
        let pname = project_name(&s.cwd, &s.project);
        let title = if s.title.is_empty() {
            "(untitled)".to_string()
        } else {
            s.title.clone()
        };
        let sid8: String = s.id.chars().take(8).collect();
        // Cap only the title part so the sid suffix (uniqueness) survives.
        let note_name = format!("{date} {} {sid8}", sanitize_component(&title, 42));

        let models: Vec<String> = conn
            .prepare(
                "SELECT DISTINCT model FROM messages
                 WHERE session_id = ?1 AND model IS NOT NULL",
            )?
            .query_map(params![s.id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<_, _>>()?;
        let subagents: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE parent_id = ?1",
            params![s.id],
            |r| r.get(0),
        )?;
        let msgs: Vec<(String, String, String)> = conn
            .prepare(
                "SELECT role, COALESCE(ts,''), content FROM messages
                 WHERE session_id = ?1 AND kind = 'text' ORDER BY line_no",
            )?
            .query_map(params![s.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?;
        let last_assistant: Option<String> = conn
            .query_row(
                "SELECT content FROM messages
                 WHERE session_id = ?1 AND role = 'assistant' AND kind = 'text'
                 ORDER BY line_no DESC LIMIT 1",
                params![s.id],
                |r| r.get(0),
            )
            .ok();

        let mut fm = String::from("---\n");
        fm.push_str("type: session\n");
        fm.push_str(&format!("session_id: {}\n", s.id));
        fm.push_str(&format!("project_name: {}\n", yaml_escape(&pname)));
        fm.push_str(&format!("project_dir: {}\n", yaml_escape(&s.project)));
        fm.push_str(&format!("cwd: {}\n", yaml_escape(&s.cwd)));
        fm.push_str(&format!("date: {date}\n"));
        fm.push_str(&format!("started: {}\n", s.first_ts));
        fm.push_str(&format!("ended: {}\n", s.last_ts));
        fm.push_str(&format!("messages: {}\n", s.user_msgs + s.assistant_msgs));
        fm.push_str(&format!("user_msgs: {}\n", s.user_msgs));
        fm.push_str(&format!("assistant_msgs: {}\n", s.assistant_msgs));
        fm.push_str(&format!("subagents: {subagents}\n"));
        if !models.is_empty() {
            fm.push_str(&format!("models: [{}]\n", models.join(", ")));
        }
        if !s.git_branch.is_empty() {
            fm.push_str(&format!("git_branch: {}\n", yaml_escape(&s.git_branch)));
        }
        fm.push_str("tags: [claude-session]\n---\n\n");

        let mut body = String::new();
        body.push_str(&format!("# {title}\n\n"));
        body.push_str(
            "> [!info] session-brain이 자동 생성한 노트입니다. 직접 수정하지 마세요 — 재생성 시 덮어씁니다.\n\n",
        );
        body.push_str(&format!("프로젝트: [[{}]]\n\n", sanitize_filename(&pname)));
        body.push_str(&format!(
            "[🌿 웹 뷰어에서 열기 (분기 트리·전문)](http://localhost:7777/#/session/{})\n※ `session-brain serve`가 떠 있을 때만 동작 — 꺼져 있으면 아래 resume 명령 사용.\n\n",
            s.id
        ));
        body.push_str(&format!(
            "이어서 작업하기:\n```\ncd {}\nclaude --resume {}\n```\n\n",
            s.cwd, s.id
        ));

        body.push_str("## 대화 흐름 (요청 → 결론)\n\n");
        let mut shown = 0usize;
        let mut i = 0usize;
        while i < msgs.len() {
            if msgs[i].0 == "user" {
                if shown >= 30 {
                    break;
                }
                let hm = msgs[i].1.get(11..16).unwrap_or("");
                body.push_str(&format!("- **{hm}** {}\n", one_line(&msgs[i].2, 300)));
                // The LAST assistant message before the next user message is
                // that turn's conclusion — more informative than the first.
                let mut j = i + 1;
                let mut turn_end: Option<&str> = None;
                while j < msgs.len() && msgs[j].0 != "user" {
                    if msgs[j].0 == "assistant" {
                        turn_end = Some(&msgs[j].2);
                    }
                    j += 1;
                }
                if let Some(a) = turn_end {
                    body.push_str(&format!("    - ↳ {}\n", one_line(a, 300)));
                }
                shown += 1;
                i = j;
                continue;
            }
            i += 1;
        }
        if s.user_msgs > 30 {
            body.push_str(&format!("- … 외 {}건\n", s.user_msgs - 30));
        }
        body.push('\n');

        if let Some(last) = &last_assistant {
            body.push_str("## 마지막 상태 (assistant)\n\n");
            let mut text: String = last.chars().take(1200).collect();
            if text.len() < last.len() {
                text.push('…');
            }
            body.push_str(&text);
            body.push_str("\n\n");
        }
        body.push_str(&format!(
            "## 검색\n\n이 세션의 상세 내용은 `session-brain show {sid8}` 또는 MCP 도구 `sessions_get`으로 조회.\n"
        ));

        fs::write(sessions_dir.join(format!("{note_name}.md")), fm + &body)?;
        n_notes += 1;
        by_project.entry(pname).or_default().push((
            date,
            note_name,
            title,
            s.user_msgs + s.assistant_msgs,
        ));
    }

    // Project MOC notes.
    for (pname, mut items) in by_project.clone() {
        items.sort_by(|a, b| b.0.cmp(&a.0));
        let mut fm = String::from("---\ntype: project\n");
        fm.push_str(&format!("project_name: {}\n", yaml_escape(&pname)));
        fm.push_str(&format!("sessions: {}\n", items.len()));
        fm.push_str(&format!(
            "last_active: {}\n",
            items.first().map(|i| i.0.as_str()).unwrap_or("")
        ));
        fm.push_str("tags: [claude-project]\n---\n\n");
        let mut body = format!("# {pname}\n\n");
        body.push_str(
            "> [!info] session-brain이 자동 생성한 노트입니다. 직접 수정하지 마세요.\n\n",
        );
        body.push_str("## 세션 목록\n\n");
        for (date, note, title, msgs) in &items {
            body.push_str(&format!("- {date} · [[{note}|{title}]] ({msgs} msgs)\n"));
        }
        fs::write(
            projects_dir.join(format!("{}.md", sanitize_filename(&pname))),
            fm + &body,
        )?;
    }

    // Home index (LLM-wiki style entry point).
    {
        let total_msgs: i64 =
            conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))?;
        let mut body = String::from(
            "---\ntype: home\ntags: [claude-session-brain]\n---\n\n# Session Brain\n\n\
             Claude Code 세션 히스토리의 자동 생성 인덱스입니다 (episodic memory 레이어).\n\
             원본은 `~/.claude/projects/`의 JSONL이며, 이 vault는 언제든 `session-brain export`로 재생성됩니다.\n\n",
        );
        body.push_str(&format!(
            "- 세션 노트: {n_notes}개 · 인덱싱된 메시지: {total_msgs}개\n"
        ));
        body.push_str("- 대시보드: [[sessions.base]] (Bases)\n\n## 프로젝트\n\n");
        let mut projs: Vec<(&String, usize, &str)> = by_project
            .iter()
            .map(|(k, v)| (k, v.len(), v.iter().map(|i| i.0.as_str()).max().unwrap_or("")))
            .collect();
        projs.sort_by(|a, b| b.2.cmp(a.2));
        for (pname, count, last) in projs {
            body.push_str(&format!(
                "- [[{}|{pname}]] — 세션 {count}개, 최근 {last}\n",
                sanitize_filename(pname)
            ));
        }
        body.push_str("\n## 최근 세션\n\n");
        let mut all: Vec<(String, String, String)> = by_project
            .values()
            .flatten()
            .map(|(d, n, t, _)| (d.clone(), n.clone(), t.clone()))
            .collect();
        all.sort_by(|a, b| b.0.cmp(&a.0));
        for (date, note, title) in all.iter().take(10) {
            body.push_str(&format!("- {date} · [[{note}|{title}]]\n"));
        }
        fs::write(vault.join("Home.md"), body)?;
    }

    // Best-effort Bases dashboard (only written once; user may customize).
    let base_path = vault.join("sessions.base");
    if !base_path.exists() {
        fs::write(
            &base_path,
            "filters:\n  and:\n    - type == \"session\"\nviews:\n  - type: table\n    name: 전체 세션\n    order:\n      - file.name\n      - project_name\n      - date\n      - messages\n      - subagents\n      - models\n    sort:\n      - property: date\n        direction: DESC\n",
        )?;
    }

    println!(
        "exported {n_notes} session notes, {} project notes → {}",
        by_project.len(),
        vault.display()
    );
    Ok(())
}
