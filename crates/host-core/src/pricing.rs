//! Model pricing and cost estimation.
//!
//! The host records raw token counts per turn but no cost. This module adds a
//! small, user-editable `model_pricing` table (per-million USD rates) and a
//! pure cost helper so the usage dashboard can show an approximate spend.
//!
//! Design choices (kept deliberately low-risk):
//!
//! * Rates are stored as TEXT so a user-typed value round-trips exactly; they
//!   are parsed to `f64` only at compute time. Cost is an *estimate* for a
//!   reference dashboard, not a billing figure, so `f64` precision is fine and
//!   avoids pulling in a decimal dependency.
//! * Cost is computed on the fly from the current pricing table, never stored
//!   on the immutable `turns` ledger. Editing a price re-derives every figure
//!   on the next read; no historical rows are rewritten.
//! * Seeding happens once, on database creation or the v20→v21 migration.
//!   Deletions and edits by the user are preserved — the seed never re-runs on
//!   a normal open.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Default per-million USD rates: (model_id, display_name, input, output,
/// cache_read, cache_write). `cache_write` maps to the provider's
/// cache-creation price; `cache_read` to the cache-hit price. Values are the
/// published list prices for each model and are freely editable in Settings.
pub const DEFAULT_PRICING: &[(&str, &str, &str, &str, &str, &str)] = &[
    // Anthropic Claude
    ("claude-opus-5-5", "Claude Opus 5.5", "4", "20", "0.20", "5"),
    ("claude-opus-5", "Claude Opus 5", "5", "25", "0.50", "6.25"),
    ("claude-opus-4-8", "Claude Opus 4.8", "5", "25", "0.50", "6.25"),
    ("claude-opus-4-7", "Claude Opus 4.7", "5", "25", "0.50", "6.25"),
    ("claude-opus-4-6", "Claude Opus 4.6", "5", "25", "0.50", "6.25"),
    ("claude-opus-4-5", "Claude Opus 4.5", "5", "25", "0.50", "6.25"),
    ("claude-sonnet-5", "Claude Sonnet 5", "2", "10", "0.20", "2.50"),
    ("claude-sonnet-4-6", "Claude Sonnet 4.6", "3", "15", "0.30", "3.75"),
    ("claude-sonnet-4-5", "Claude Sonnet 4.5", "3", "15", "0.30", "3.75"),
    ("claude-fable-5-1", "Claude Fable 5.1", "10", "50", "0.25", "12.50"),
    ("claude-mythos-5-1", "Claude Mythos 5.1", "10", "50", "0.25", "12.50"),
    ("claude-fable-5", "Claude Fable 5", "10", "50", "1.00", "12.50"),
    ("claude-mythos-5", "Claude Mythos 5", "10", "50", "1.00", "12.50"),
    ("claude-3-5-haiku", "Claude 3.5 Haiku", "0.80", "4", "0.08", "1"),
    // OpenAI GPT / o-series
    ("gpt-6-astra", "GPT-6 Astra", "10", "50", "1", "12.5"),
    ("gpt-6-sol", "GPT-6 Sol", "2", "10", "0.20", "2.50"),
    ("gpt-6-luna", "GPT-6 Luna", "0.10", "0.50", "0.01", "0.125"),
    ("gpt-5.6-sol", "GPT-5.6 Sol", "4", "20", "0.40", "5"),
    ("gpt-5.6-terra", "GPT-5.6 Terra", "2", "12", "0.20", "2.50"),
    ("gpt-5.6", "GPT-5.6", "4", "20", "0.40", "5"),
    ("gpt-5.5", "GPT-5.5", "5", "30", "0.50", "0"),
    ("gpt-5.5-pro", "GPT-5.5 Pro", "30", "180", "0", "0"),
    ("gpt-5.4", "GPT-5.4", "2.50", "15", "0.25", "0"),
    ("gpt-5.4-mini", "GPT-5.4 Mini", "0.75", "4.50", "0.075", "0"),
    ("gpt-5.4-nano", "GPT-5.4 Nano", "0.20", "1.25", "0.02", "0"),
    ("gpt-5.4-pro", "GPT-5.4 Pro", "30", "180", "0", "0"),
    ("gpt-5.2", "GPT-5.2", "1.75", "14", "0.175", "0"),
    ("gpt-5.2-codex", "GPT-5.2 Codex", "1.75", "14", "0.175", "0"),
    ("gpt-5.2-pro", "GPT-5.2 Pro", "21", "168", "0", "0"),
    ("gpt-5.3-codex", "GPT-5.3 Codex", "1.75", "14", "0.175", "0"),
    ("gpt-5.1", "GPT-5.1", "1.25", "10", "0.125", "0"),
    ("gpt-5.1-codex", "GPT-5.1 Codex", "1.25", "10", "0.125", "0"),
    ("gpt-5", "GPT-5", "1.25", "10", "0.125", "0"),
    ("gpt-5-codex", "GPT-5 Codex", "1.25", "10", "0.125", "0"),
    ("gpt-5-mini", "GPT-5 Mini", "0.25", "2", "0.025", "0"),
    ("gpt-5-nano", "GPT-5 Nano", "0.05", "0.40", "0.005", "0"),
    ("gpt-4.1", "GPT-4.1", "2", "8", "0.50", "0"),
    ("gpt-4.1-mini", "GPT-4.1 Mini", "0.40", "1.60", "0.10", "0"),
    ("gpt-4.1-nano", "GPT-4.1 Nano", "0.10", "0.40", "0.025", "0"),
    ("gpt-4o", "GPT-4o", "2.50", "10", "1.25", "0"),
    ("gpt-4o-mini", "GPT-4o Mini", "0.15", "0.60", "0.075", "0"),
    ("o3", "OpenAI o3", "2", "8", "0.50", "0"),
    ("o3-pro", "OpenAI o3-pro", "20", "80", "0", "0"),
    ("o3-mini", "OpenAI o3-mini", "1.10", "4.40", "0.55", "0"),
    ("o4-mini", "OpenAI o4-mini", "1.10", "4.40", "0.275", "0"),
    ("o1", "OpenAI o1", "15", "60", "7.50", "0"),
    ("o1-mini", "OpenAI o1-mini", "0.55", "2.20", "0.55", "0"),
    ("codex-mini", "Codex Mini", "0.75", "3", "0.025", "0"),
    // DeepSeek
    ("deepseek-v3", "DeepSeek V3", "0.28", "1.11", "0.028", "0"),
    ("deepseek-chat", "DeepSeek Chat", "0.28", "1.11", "0.028", "0"),
    ("deepseek-reasoner", "DeepSeek Reasoner", "0.55", "2.19", "0.14", "0"),
    // Moonshot Kimi
    ("kimi-k2-0905", "Kimi K2", "0.55", "2.20", "0.10", "0"),
    ("kimi-k2.5", "Kimi K2.5", "0.60", "3.00", "0.10", "0"),
    ("kimi-k2.6", "Kimi K2.6", "0.95", "4.00", "0.16", "0"),
    ("kimi-k3", "Kimi K3", "3.00", "15.00", "0.30", "0"),
    // Zhipu GLM
    ("glm-4.6", "GLM-4.6", "0.6", "2.2", "0.11", "0"),
    ("glm-4.7", "GLM-4.7", "0.6", "2.2", "0.11", "0"),
    ("glm-5", "GLM-5", "1", "3.2", "0.2", "0"),
    ("glm-5.1", "GLM-5.1", "1.4", "4.4", "0.26", "0"),
    ("glm-5-turbo", "GLM-5-Turbo", "1.2", "4", "0.24", "0"),
    // Alibaba Qwen
    ("qwen3.8-max", "Qwen3.8 Max", "2", "6", "0.25", "2.50"),
    ("qwen3.7-max", "Qwen3.7 Max", "2.50", "7.50", "0.25", "0"),
    ("qwen3.7-plus", "Qwen3.7 Plus", "0.40", "1.60", "0.08", "0"),
    ("qwen3-max", "Qwen3 Max", "0.78", "3.90", "0", "0"),
    ("qwen3-32b", "Qwen3 32B", "0.16", "0.64", "0", "0"),
    // xAI Grok
    ("grok-4.7", "Grok 4.7", "2", "6", "0.50", "0"),
    ("grok-4.6", "Grok 4.6", "2", "6", "0.50", "0"),
    ("grok-4.5", "Grok 4.5", "2", "6", "0.30", "0"),
    ("grok-4", "Grok 4", "3", "15", "0.75", "0"),
    ("grok-3", "Grok 3", "3", "15", "0.75", "0"),
    ("grok-3-mini", "Grok 3 Mini", "0.25", "0.50", "0.075", "0"),
    // MiniMax
    ("minimax-m2", "MiniMax M2", "0.30", "1.20", "0.03", "0.375"),
    ("minimax-m3", "MiniMax M3", "0.30", "1.20", "0.06", "0"),
    // Mistral
    ("codestral-2508", "Codestral", "0.30", "0.90", "0.03", "0"),
    ("devstral-2-2512", "Devstral 2", "0.40", "2", "0.04", "0"),
    ("magistral-medium", "Magistral Medium", "2", "5", "0", "0"),
    // Cohere
    ("command-a", "Cohere Command A", "2.50", "10", "0", "0"),
    ("command-r", "Cohere Command R", "0.15", "0.60", "0", "0"),
];

/// Parsed per-million rates for one model.
#[derive(Debug, Clone, Copy, Default)]
pub struct PricingRow {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

fn parse_rate(value: &str) -> f64 {
    value.trim().parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(0.0)
}

/// Create the pricing table if missing. Idempotent; safe on every open.
pub fn ensure_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS model_pricing (
            model_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            input_cost_per_million TEXT NOT NULL DEFAULT '0',
            output_cost_per_million TEXT NOT NULL DEFAULT '0',
            cache_read_cost_per_million TEXT NOT NULL DEFAULT '0',
            cache_write_cost_per_million TEXT NOT NULL DEFAULT '0'
        );",
    )?;
    Ok(())
}

/// Insert the default price list. `INSERT OR IGNORE` keeps any row the user has
/// already customised untouched, so this is safe to call on create/migrate.
pub fn seed_defaults(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO model_pricing
            (model_id, display_name, input_cost_per_million, output_cost_per_million,
             cache_read_cost_per_million, cache_write_cost_per_million)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for (id, name, input, output, cache_read, cache_write) in DEFAULT_PRICING {
        stmt.execute(params![id, name, input, output, cache_read, cache_write])?;
    }
    Ok(())
}

/// Create the table and seed it in one step (fresh DB / migration entry point).
pub fn ensure_seeded(conn: &Connection) -> Result<()> {
    ensure_table(conn)?;
    seed_defaults(conn)?;
    Ok(())
}

/// Load the pricing table into a lookup keyed by lower-cased model id.
pub fn load_pricing_map(conn: &Connection) -> Result<HashMap<String, PricingRow>> {
    ensure_table(conn)?;
    let mut stmt = conn.prepare_cached(
        "SELECT model_id, input_cost_per_million, output_cost_per_million,
                cache_read_cost_per_million, cache_write_cost_per_million
         FROM model_pricing",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (id, input, output, cache_read, cache_write) = row?;
        map.insert(
            id.to_lowercase(),
            PricingRow {
                input: parse_rate(&input),
                output: parse_rate(&output),
                cache_read: parse_rate(&cache_read),
                cache_write: parse_rate(&cache_write),
            },
        );
    }
    Ok(map)
}

/// Strip a trailing `-YYYYMMDD` (or `-YYYYMM`) dated snapshot suffix so a
/// logged `claude-sonnet-4-5-20250929` resolves to the `claude-sonnet-4-5` row.
fn strip_date_suffix(id: &str) -> Option<&str> {
    let (head, tail) = id.rsplit_once('-')?;
    let digits = tail.len();
    if (6..=8).contains(&digits) && tail.bytes().all(|b| b.is_ascii_digit()) {
        Some(head)
    } else {
        None
    }
}

/// Resolve a model id to its pricing row: exact (case-insensitive) match first,
/// then retry after dropping a dated snapshot suffix. Returns None when the
/// model has no price, so callers can flag the usage as unpriced.
pub fn resolve<'a>(
    map: &'a HashMap<String, PricingRow>,
    model_id: &str,
) -> Option<&'a PricingRow> {
    let key = model_id.trim().to_lowercase();
    if key.is_empty() {
        return None;
    }
    if let Some(row) = map.get(&key) {
        return Some(row);
    }
    let mut current = key.as_str();
    while let Some(stripped) = strip_date_suffix(current) {
        if let Some(row) = map.get(stripped) {
            return Some(row);
        }
        current = stripped;
    }
    None
}

/// Estimated USD cost for one turn's token counts under the given rates.
///
/// `input_tokens` is treated as fresh input (Anthropic semantics); cache read
/// and cache write are billed separately. For providers whose input count is
/// cache-inclusive this can slightly overcount, which is acceptable for an
/// approximate reference figure.
pub fn cost_usd(
    row: &PricingRow,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
) -> f64 {
    let per_million = |tokens: i64, rate: f64| (tokens.max(0) as f64) / 1_000_000.0 * rate;
    per_million(input, row.input)
        + per_million(output, row.output)
        + per_million(cache_read, row.cache_read)
        + per_million(cache_write, row.cache_write)
}

/// The full pricing table as JSON rows, ordered by display name for the editor.
pub fn list_pricing(conn: &Connection) -> Result<Value> {
    ensure_table(conn)?;
    let mut stmt = conn.prepare(
        "SELECT model_id, display_name, input_cost_per_million, output_cost_per_million,
                cache_read_cost_per_million, cache_write_cost_per_million
         FROM model_pricing
         ORDER BY display_name COLLATE NOCASE ASC, model_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(json!({
            "modelId": row.get::<_, String>(0)?,
            "displayName": row.get::<_, String>(1)?,
            "inputCostPerMillion": row.get::<_, String>(2)?,
            "outputCostPerMillion": row.get::<_, String>(3)?,
            "cacheReadCostPerMillion": row.get::<_, String>(4)?,
            "cacheWriteCostPerMillion": row.get::<_, String>(5)?,
        }))
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(json!({ "models": out }))
}

fn normalize_rate(value: Option<&str>) -> Result<String> {
    let raw = value.unwrap_or("0").trim();
    let raw = if raw.is_empty() { "0" } else { raw };
    let parsed = raw
        .parse::<f64>()
        .map_err(|_| anyhow::anyhow!("invalid price value: {raw}"))?;
    if !parsed.is_finite() || parsed < 0.0 {
        return Err(anyhow::anyhow!("price must be a non-negative number: {raw}"));
    }
    // Store the trimmed, canonical string the user typed (already validated).
    Ok(raw.to_string())
}

/// Insert or update one model's pricing. `model_id` is required; a blank
/// display name falls back to the id.
pub fn upsert_pricing(conn: &Connection, params_json: &Value) -> Result<Value> {
    let model_id = params_json
        .get("modelId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("modelId is required"))?;
    let display_name = params_json
        .get("displayName")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(model_id);
    let input = normalize_rate(params_json.get("inputCostPerMillion").and_then(|v| v.as_str()))?;
    let output = normalize_rate(params_json.get("outputCostPerMillion").and_then(|v| v.as_str()))?;
    let cache_read =
        normalize_rate(params_json.get("cacheReadCostPerMillion").and_then(|v| v.as_str()))?;
    let cache_write =
        normalize_rate(params_json.get("cacheWriteCostPerMillion").and_then(|v| v.as_str()))?;

    ensure_table(conn)?;
    conn.execute(
        "INSERT INTO model_pricing
            (model_id, display_name, input_cost_per_million, output_cost_per_million,
             cache_read_cost_per_million, cache_write_cost_per_million)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(model_id) DO UPDATE SET
             display_name = excluded.display_name,
             input_cost_per_million = excluded.input_cost_per_million,
             output_cost_per_million = excluded.output_cost_per_million,
             cache_read_cost_per_million = excluded.cache_read_cost_per_million,
             cache_write_cost_per_million = excluded.cache_write_cost_per_million",
        params![model_id, display_name, input, output, cache_read, cache_write],
    )?;
    list_pricing(conn)
}

/// Delete one model's pricing row. Missing ids are a no-op.
pub fn delete_pricing(conn: &Connection, model_id: &str) -> Result<Value> {
    ensure_table(conn)?;
    conn.execute(
        "DELETE FROM model_pricing WHERE model_id = ?1",
        params![model_id.trim()],
    )?;
    list_pricing(conn)
}

/// Restore the seeded defaults: overwrite every default row's rates back to the
/// shipped values (and re-add any the user deleted) while leaving user-added
/// custom models in place.
pub fn reset_defaults(conn: &Connection) -> Result<Value> {
    ensure_table(conn)?;
    let mut stmt = conn.prepare(
        "INSERT INTO model_pricing
            (model_id, display_name, input_cost_per_million, output_cost_per_million,
             cache_read_cost_per_million, cache_write_cost_per_million)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(model_id) DO UPDATE SET
             display_name = excluded.display_name,
             input_cost_per_million = excluded.input_cost_per_million,
             output_cost_per_million = excluded.output_cost_per_million,
             cache_read_cost_per_million = excluded.cache_read_cost_per_million,
             cache_write_cost_per_million = excluded.cache_write_cost_per_million",
    )?;
    for (id, name, input, output, cache_read, cache_write) in DEFAULT_PRICING {
        stmt.execute(params![id, name, input, output, cache_read, cache_write])?;
    }
    drop(stmt);
    list_pricing(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_seeded(&conn).unwrap();
        conn
    }

    #[test]
    fn seeds_defaults_and_loads_map() {
        let conn = mem();
        let map = load_pricing_map(&conn).unwrap();
        assert!(map.contains_key("gpt-5"));
        assert!(map.contains_key("claude-opus-4-8"));
        let gpt5 = map.get("gpt-5").unwrap();
        assert_eq!(gpt5.input, 1.25);
        assert_eq!(gpt5.output, 10.0);
    }

    #[test]
    fn resolve_matches_exact_and_dated_suffix() {
        let conn = mem();
        let map = load_pricing_map(&conn).unwrap();
        // Exact, case-insensitive.
        assert!(resolve(&map, "GPT-5").is_some());
        // Dated snapshot falls back to the base row.
        assert!(resolve(&map, "claude-sonnet-4-5-20250929").is_some());
        // Unknown model is unpriced.
        assert!(resolve(&map, "some-local-model:7b").is_none());
    }

    #[test]
    fn cost_is_tokens_times_rate_over_million() {
        let row = PricingRow { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 };
        // 1000*3/1e6 + 500*15/1e6 + 200*0.3/1e6 + 100*3.75/1e6
        let cost = cost_usd(&row, 1000, 500, 200, 100);
        assert!((cost - 0.010935).abs() < 1e-9);
    }

    #[test]
    fn upsert_then_delete_round_trips() {
        let conn = mem();
        let before = load_pricing_map(&conn).unwrap();
        assert!(!before.contains_key("my-model"));
        upsert_pricing(
            &conn,
            &json!({
                "modelId": "my-model",
                "displayName": "My Model",
                "inputCostPerMillion": "1.5",
                "outputCostPerMillion": "3",
                "cacheReadCostPerMillion": "0",
                "cacheWriteCostPerMillion": "0"
            }),
        )
        .unwrap();
        let after = load_pricing_map(&conn).unwrap();
        assert_eq!(after.get("my-model").unwrap().input, 1.5);
        delete_pricing(&conn, "my-model").unwrap();
        let gone = load_pricing_map(&conn).unwrap();
        assert!(!gone.contains_key("my-model"));
    }

    #[test]
    fn upsert_rejects_invalid_rate() {
        let conn = mem();
        let err = upsert_pricing(
            &conn,
            &json!({ "modelId": "x", "inputCostPerMillion": "abc" }),
        );
        assert!(err.is_err());
    }

    #[test]
    fn reset_restores_edited_and_deleted_defaults() {
        let conn = mem();
        // Edit a default and delete another.
        upsert_pricing(
            &conn,
            &json!({ "modelId": "gpt-5", "inputCostPerMillion": "999" }),
        )
        .unwrap();
        delete_pricing(&conn, "claude-opus-4-8").unwrap();
        reset_defaults(&conn).unwrap();
        let map = load_pricing_map(&conn).unwrap();
        assert_eq!(map.get("gpt-5").unwrap().input, 1.25);
        assert!(map.contains_key("claude-opus-4-8"));
    }
}
