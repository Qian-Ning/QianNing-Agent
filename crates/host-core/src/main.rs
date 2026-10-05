mod activation;
mod agent_capabilities;
mod artifacts;
mod audit;
mod computer;
mod config_sync;
mod connection;
mod db;
mod keyboard;
mod mcp_servers;
mod network_policy;
mod network_proxy;
mod notifications;
mod permissions;
mod plans;
mod plugin_sessions;
mod plugin_usage;
mod plugins;
mod pricing;
mod providers;
mod review;
mod rpc;
mod scheduled;
mod scratch;
mod secrets;
mod session_collaboration;
mod session_search;
mod sessions;
mod state;
mod tool_budget;
mod tools;
mod transcripts;
mod turn_queue;
mod user_skills;
mod user_subagents;
mod workspace;

use std::sync::Arc;
use tokio::sync::Mutex;
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|arg| arg == tools::INTERNAL_TOOL_RUNNER_FLAG) {
        let exit_code = match tools::run_internal_tool_runner().await {
            Ok(exit_code) => exit_code,
            Err(error) => {
                eprintln!("internal tool runner failed: {error:#}");
                1
            }
        };
        std::process::exit(exit_code);
    }

    // The SSH askpass helper. `ssh` re-invokes this binary as `SSH_ASKPASS` and
    // reads one answer from its stdout, so it is handled before logging is
    // configured: anything else on stdout would be read as the credential. What
    // identifies this process is the marker in its environment, because OpenSSH
    // passes a prompt rather than an argument of ours. The value itself arrives
    // in the `0600` file the spawn staged, never in this environment, and it is
    // written to a pipe the parent already owns — never to a log or the store.
    if connection::ssh::is_askpass_child(std::env::args(), |key| std::env::var(key).ok()) {
        if let Err(message) = answer_askpass() {
            eprintln!("connection askpass: {message}");
            std::process::exit(1);
        }
        std::process::exit(0);
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let data_dir = std::env::var("PI_DESKTOP_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".qianning-agent")
        });

    std::fs::create_dir_all(&data_dir)?;
    std::fs::create_dir_all(data_dir.join("logs"))?;
    std::fs::create_dir_all(data_dir.join("plugins/installed"))?;
    std::fs::create_dir_all(data_dir.join("plugins/data"))?;
    std::fs::create_dir_all(data_dir.join("plugins/market"))?;
    std::fs::create_dir_all(data_dir.join("plugins/cache/download"))?;
    std::fs::create_dir_all(data_dir.join("cache"))?;
    std::fs::create_dir_all(data_dir.join("scratch"))?;

    let state = Arc::new(Mutex::new(AppState::open(&data_dir)?));
    tracing::info!(path = %data_dir.display(), "host-core starting");
    {
        // Sweep orphaned/stale session scratch dirs left behind by crashes or
        // deletions that bypassed session.delete (D114).
        let st = state.lock().await;
        // Only sweep with a real session list: an empty fallback on a db
        // error would wipe scratch dirs of sessions that still exist.
        if let Ok(list) = sessions::list_sessions(&st.db) {
            let live: std::collections::HashSet<String> = list.into_iter().map(|s| s.id).collect();
            scratch::sweep(&data_dir, &live);
            review::sweep(&data_dir, &live);
        }
    }
    rpc::serve(state).await
}

/// Answer one askpass prompt: echo the credential the caller staged for it.
///
/// The value is read from the `0600` file the spawn wrote for this one answer,
/// so no environment variable ever holds it. It is written to stdout byte for
/// byte, followed by the line break `ssh` reads the answer up to.
fn answer_askpass() -> Result<(), String> {
    let path = std::env::var(connection::ssh::ASKPASS_SECRET_FILE_ENV)
        .map_err(|_| "no credential path in the environment".to_string())?;
    let secret =
        std::fs::read(&path).map_err(|err| format!("credential file unreadable: {err}"))?;

    let mut out = std::io::stdout().lock();
    std::io::Write::write_all(&mut out, &secret)
        .and_then(|()| std::io::Write::write_all(&mut out, b"\n"))
        .and_then(|()| std::io::Write::flush(&mut out))
        .map_err(|err| format!("the answer could not be written: {err}"))
}
