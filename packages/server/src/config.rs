use std::path::PathBuf;

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub livekit_api_key: String,
    pub livekit_api_secret: String,
    /// URL the CLIENTS use to reach LiveKit signaling (ws:// or wss://).
    pub livekit_public_url: String,
    /// URL THIS SERVER uses to reach LiveKit's HTTP API (RoomService).
    pub livekit_internal_url: String,
    /// Base URL share links are minted under (no trailing slash).
    pub public_base_url: String,
    pub static_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Self {
        let livekit_api_key = std::env::var("LIVEKIT_API_KEY").unwrap_or_else(|_| {
            tracing::warn!(
                "LIVEKIT_API_KEY not set — using LiveKit DEV credentials (local dev only)"
            );
            "devkey".into()
        });
        let livekit_api_secret =
            std::env::var("LIVEKIT_API_SECRET").unwrap_or_else(|_| "secret".into());

        Self {
            port: std::env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(8090),
            livekit_api_key,
            livekit_api_secret,
            livekit_public_url: std::env::var("LIVEKIT_PUBLIC_URL")
                .unwrap_or_else(|_| "ws://localhost:7880".into()),
            livekit_internal_url: std::env::var("LIVEKIT_INTERNAL_URL")
                .unwrap_or_else(|_| "http://localhost:7880".into()),
            public_base_url: std::env::var("PUBLIC_BASE_URL")
                .unwrap_or_else(|_| "http://localhost:8090".into()),
            static_dir: std::env::var("STATIC_DIR")
                .unwrap_or_else(|_| "packages/web/dist".into())
                .into(),
        }
    }
}
