use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use livekit_api::access_token::{AccessToken, VideoGrants};
use rand::distr::{Alphanumeric, SampleString};
use serde::Serialize;
use ts_rs::TS;

use crate::config::Config;

/// 12 alphanumeric chars ≈ 71 bits of entropy — unguessable share links.
pub const SESSION_ID_LEN: usize = 12;
/// Publishers hold one token for the whole stream.
const PUBLISHER_TOKEN_TTL: Duration = Duration::from_secs(12 * 60 * 60);
/// Viewer tokens are throwaway; the page re-mints on rejoin.
const VIEWER_TOKEN_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub share_url: String,
    pub publisher_token: String,
    pub livekit_url: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct ViewerTokenResponse {
    pub token: String,
    pub livekit_url: String,
}

fn rand_string(len: usize) -> String {
    Alphanumeric.sample_string(&mut rand::rng(), len)
}

/// The server is stateless: the LiveKit room (auto-created on first join,
/// named by the session id) is the only session state that exists.
fn mint_token(
    cfg: &Config,
    room: &str,
    identity: &str,
    can_publish: bool,
    ttl: Duration,
) -> Result<String, StatusCode> {
    AccessToken::with_api_key(&cfg.livekit_api_key, &cfg.livekit_api_secret)
        .with_identity(identity)
        .with_ttl(ttl)
        .with_grants(VideoGrants {
            room_join: true,
            room: room.to_owned(),
            can_publish,
            can_subscribe: !can_publish,
            can_publish_data: false,
            ..Default::default()
        })
        .to_jwt()
        .map_err(|e| {
            tracing::error!("failed to mint token: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

pub async fn create_session(
    State(cfg): State<Config>,
) -> Result<Json<CreateSessionResponse>, StatusCode> {
    let id = rand_string(SESSION_ID_LEN);
    let publisher_token = mint_token(&cfg, &id, "publisher", true, PUBLISHER_TOKEN_TTL)?;
    Ok(Json(CreateSessionResponse {
        share_url: format!("{}/s/{}", cfg.public_base_url, id),
        session_id: id,
        publisher_token,
        livekit_url: cfg.livekit_public_url.clone(),
    }))
}

pub async fn viewer_token(
    State(cfg): State<Config>,
    Path(id): Path<String>,
) -> Result<Json<ViewerTokenResponse>, StatusCode> {
    if id.len() != SESSION_ID_LEN || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(StatusCode::NOT_FOUND);
    }
    let identity = format!("viewer-{}", rand_string(8));
    let token = mint_token(&cfg, &id, &identity, false, VIEWER_TOKEN_TTL)?;
    Ok(Json(ViewerTokenResponse {
        token,
        livekit_url: cfg.livekit_public_url.clone(),
    }))
}
