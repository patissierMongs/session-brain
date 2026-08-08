//! Minimal Ollama HTTP client for local embedding (plain HTTP, localhost).

use anyhow::{Context, Result};
use serde::Deserialize;
use std::time::Duration;

pub fn default_model() -> String {
    std::env::var("SESSION_BRAIN_EMBED_MODEL")
        .unwrap_or_else(|_| "qwen3-embedding:8b".to_string())
}

pub fn default_url() -> String {
    std::env::var("SESSION_BRAIN_OLLAMA_URL")
        .unwrap_or_else(|_| "http://localhost:11434".to_string())
}

#[derive(Deserialize)]
struct EmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

/// Embed a batch of texts via Ollama's /api/embed.
pub fn embed_batch(base_url: &str, model: &str, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
    let url = format!("{}/api/embed", base_url.trim_end_matches('/'));
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(600))
        .build();
    let body = serde_json::json!({ "model": model, "input": inputs });
    let resp: EmbedResponse = agent
        .post(&url)
        .send_json(body)
        .with_context(|| format!("Ollama request failed ({url}) — is Ollama running?"))?
        .into_json()
        .context("failed to parse Ollama embed response")?;
    anyhow::ensure!(
        resp.embeddings.len() == inputs.len(),
        "Ollama returned {} embeddings for {} inputs",
        resp.embeddings.len(),
        inputs.len()
    );
    Ok(resp.embeddings)
}
