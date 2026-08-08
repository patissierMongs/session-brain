//! Defensive parser for Claude Code session JSONL lines.
//!
//! The format is NOT an official spec and may change between versions.
//! Rules: unknown fields are ignored, missing fields never fail,
//! unknown line types are skipped by the caller.

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawLine {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub session_id: Option<String>,
    pub uuid: Option<String>,
    pub parent_uuid: Option<String>,
    pub timestamp: Option<String>,
    #[serde(default)]
    pub is_sidechain: bool,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub ai_title: Option<String>,
    pub summary: Option<String>,
    pub message: Option<RawMessage>,
}

#[derive(Debug, Deserialize)]
pub struct RawMessage {
    pub model: Option<String>,
    #[serde(default)]
    pub content: Value,
}

/// Injected/system noise that pollutes search results if indexed.
const NOISE_PREFIXES: &[&str] = &[
    "<command-name>",
    "<command-message>",
    "<local-command",
    "<task-notification>",
    "<system-reminder>",
    "Caveat: The messages below",
];

pub fn is_noise(text: &str) -> bool {
    let t = text.trim_start();
    NOISE_PREFIXES.iter().any(|p| t.starts_with(p))
}

/// Extract human-visible text from a message content value.
/// String content is taken as-is; array content keeps only `text` blocks.
/// tool_use / tool_result / thinking blocks are intentionally skipped.
pub fn extract_text(content: &Value) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    match content {
        Value::String(s) => {
            if !s.trim().is_empty() {
                parts.push(s);
            }
        }
        Value::Array(items) => {
            for it in items {
                if it.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(t) = it.get("text").and_then(Value::as_str) {
                        if !t.trim().is_empty() {
                            parts.push(t);
                        }
                    }
                }
            }
        }
        _ => {}
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

/// Compact summary of tool activity in a message (shown collapsed in the
/// web UI). Assistant tool_use → tool name + input excerpt; user
/// tool_result → result excerpt.
pub fn extract_tool_summary(content: &Value) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Value::Array(items) = content {
        for it in items {
            match it.get("type").and_then(Value::as_str) {
                Some("tool_use") => {
                    let name = it.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = it.get("input").map(|v| v.to_string()).unwrap_or_default();
                    let excerpt: String = input.chars().take(400).collect();
                    parts.push(format!("Tool: {name}\n{excerpt}"));
                }
                Some("tool_result") => {
                    let text = match it.get("content") {
                        Some(Value::String(s)) => s.clone(),
                        Some(Value::Array(arr)) => arr
                            .iter()
                            .filter_map(|b| b.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n"),
                        _ => String::new(),
                    };
                    let is_err = it
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let excerpt: String = text.chars().take(500).collect();
                    parts.push(format!(
                        "→{}{excerpt}",
                        if is_err { " [error] " } else { " " }
                    ));
                }
                _ => {}
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

/// Extract Claude's internal thinking blocks (shown collapsed in the web UI).
pub fn extract_thinking(content: &Value) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    if let Value::Array(items) = content {
        for it in items {
            if it.get("type").and_then(Value::as_str) == Some("thinking") {
                if let Some(t) = it.get("thinking").and_then(Value::as_str) {
                    if !t.trim().is_empty() {
                        parts.push(t);
                    }
                }
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}
