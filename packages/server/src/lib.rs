pub mod api;
pub mod config;

use axum::{
    routing::{get, post},
    Router,
};
use tower_http::services::{ServeDir, ServeFile};

pub fn build_router(cfg: config::Config) -> Router {
    // Anything that isn't an API route falls through to the SPA: real files are
    // served as-is, unknown paths (e.g. /s/<id>) get index.html.
    let index = cfg.static_dir.join("index.html");
    let static_svc = ServeDir::new(&cfg.static_dir).fallback(ServeFile::new(index));

    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/sessions", post(api::create_session))
        .route("/api/sessions/{id}/token", get(api::viewer_token))
        .with_state(cfg)
        .fallback_service(static_svc)
}
