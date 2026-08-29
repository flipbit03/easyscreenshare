pub mod api;
pub mod config;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use axum::{
    routing::{get, post},
    Router,
};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

/// A live session, kept alive by the publisher's heartbeat. Expires TTL after
/// the last beat, which frees the (possibly vanity) id for reuse.
pub struct SessionEntry {
    pub last_seen: Instant,
    /// Secret returned to the publisher at creation; required to heartbeat,
    /// so a stale beat can't resurrect a name someone else has since claimed.
    pub secret: String,
    /// 4-digit access PIN; None = public stream. Rotated on every kick.
    pub pin: Option<String>,
    /// Wrong-PIN rate limiting: client key -> (attempts, window start).
    pub pin_attempts: HashMap<String, (u32, Instant)>,
    /// LiveKit room for THIS streaming session: "{id}-{nonce}". Never the
    /// bare id — a reused room name would let viewers admitted to a past
    /// stream (still-open connections, unexpired tokens) into the next one.
    pub room: String,
}

pub type Sessions = Mutex<HashMap<String, SessionEntry>>;

#[derive(Clone)]
pub struct AppState {
    pub cfg: config::Config,
    pub sessions: std::sync::Arc<Sessions>,
}

pub fn build_router(cfg: config::Config) -> Router {
    let state = AppState {
        cfg: cfg.clone(),
        sessions: std::sync::Arc::new(Mutex::new(HashMap::new())),
    };

    let index = cfg.static_dir.join("index.html");
    let static_svc = ServeDir::new(&cfg.static_dir).fallback(ServeFile::new(index));

    // The /api surface is a public, unauthenticated API — the Electron
    // renderer calls it cross-origin, so allow any origin.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/sessions", post(api::create_session))
        .route("/api/names/{name}", get(api::check_name))
        .route("/api/sessions/{id}/heartbeat", post(api::heartbeat))
        .route("/api/sessions/{id}/token", post(api::viewer_token))
        .route("/api/sessions/{id}/kick", post(api::kick))
        .route("/api/sessions/{id}/end", post(api::end_session))
        .layer(cors)
        .with_state(state)
        .fallback_service(static_svc)
}
