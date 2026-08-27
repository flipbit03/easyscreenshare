use std::time::{Duration, Instant};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use livekit_api::access_token::{AccessToken, VideoGrants};
use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{config::Config, AppState, SessionEntry};

/// Random ids are 12 alphanumeric chars ≈ 71 bits.
pub const SESSION_ID_LEN: usize = 12;
const SESSION_SECRET_LEN: usize = 24;
/// A session is considered live for this long after its last heartbeat.
const SESSION_TTL: Duration = Duration::from_secs(20);
const PUBLISHER_TOKEN_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const VIEWER_TOKEN_TTL: Duration = Duration::from_secs(10 * 60);
/// Vanity-name rules: keeps names link-clean and away from control chars.
const NAME_MIN: usize = 3;
const NAME_MAX: usize = 32;

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct CreateSessionRequest {
    /// Optional vanity id (e.g. "cadu" → /s/cadu). First-come, first-served
    /// while live; omitted → a random id.
    pub name: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub session_secret: String,
    pub share_url: String,
    pub publisher_token: String,
    pub livekit_url: String,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct HeartbeatRequest {
    pub secret: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct ViewerTokenResponse {
    pub token: String,
    pub livekit_url: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct NameAvailability {
    /// Passes the vanity-name format rules.
    pub valid: bool,
    /// Not currently claimed by a live session (only meaningful if `valid`).
    pub available: bool,
}

fn rand_string(len: usize) -> String {
    Alphanumeric.sample_string(&mut rand::rng(), len)
}

fn valid_name(name: &str) -> bool {
    (NAME_MIN..=NAME_MAX).contains(&name.chars().count())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

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
            can_update_own_metadata: !can_publish,
            ..Default::default()
        })
        .to_jwt()
        .map_err(|e| {
            tracing::error!("failed to mint token: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

pub async fn create_session(
    State(state): State<AppState>,
    body: Option<Json<CreateSessionRequest>>,
) -> Result<Json<CreateSessionResponse>, (StatusCode, String)> {
    let requested = body.and_then(|b| b.0.name);
    let id = match requested {
        Some(name) => {
            let name = name.trim().to_owned();
            if !valid_name(&name) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "name must be 3–32 chars: letters, digits, - or _".into(),
                ));
            }
            name
        }
        None => rand_string(SESSION_ID_LEN),
    };

    let secret = rand_string(SESSION_SECRET_LEN);
    // Atomic claim: check-and-insert under the lock so two simultaneous
    // requests for the same name can't both win.
    {
        let mut sessions = state.sessions.lock().unwrap();
        if let Some(existing) = sessions.get(&id) {
            if existing.last_seen.elapsed() < SESSION_TTL {
                return Err((
                    StatusCode::CONFLICT,
                    format!("\"{id}\" is in use right now — pick another name"),
                ));
            }
        }
        sessions.insert(
            id.clone(),
            SessionEntry {
                last_seen: Instant::now(),
                secret: secret.clone(),
            },
        );
    }

    let publisher_token = mint_token(&state.cfg, &id, "publisher", true, PUBLISHER_TOKEN_TTL)
        .map_err(|s| (s, "token error".into()))?;
    Ok(Json(CreateSessionResponse {
        share_url: format!("{}/s/{}", state.cfg.public_base_url, id),
        session_id: id,
        session_secret: secret,
        publisher_token,
        livekit_url: state.cfg.livekit_public_url.clone(),
    }))
}

/// Read-only availability check for the live name indicator — never claims
/// the name (a claim only happens at create_session).
pub async fn check_name(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Json<NameAvailability> {
    let name = name.trim();
    if !valid_name(name) {
        return Json(NameAvailability {
            valid: false,
            available: false,
        });
    }
    let sessions = state.sessions.lock().unwrap();
    let taken = matches!(
        sessions.get(name),
        Some(e) if e.last_seen.elapsed() < SESSION_TTL
    );
    Json(NameAvailability {
        valid: true,
        available: !taken,
    })
}

pub async fn heartbeat(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<HeartbeatRequest>,
) -> StatusCode {
    let mut sessions = state.sessions.lock().unwrap();
    match sessions.get_mut(&id) {
        Some(entry) if entry.secret == body.secret => {
            entry.last_seen = Instant::now();
            StatusCode::NO_CONTENT
        }
        // Wrong/absent secret: don't leak whether the id exists.
        _ => StatusCode::FORBIDDEN,
    }
}

pub async fn viewer_token(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ViewerTokenResponse>, StatusCode> {
    // Authoritative liveness: a viewer can only join a session that a
    // publisher is currently heartbeating. Unknown/expired → 404, so dead
    // links error instead of waiting forever.
    {
        let sessions = state.sessions.lock().unwrap();
        match sessions.get(&id) {
            Some(entry) if entry.last_seen.elapsed() < SESSION_TTL => {}
            _ => return Err(StatusCode::NOT_FOUND),
        }
    }
    let identity = format!("viewer-{}", rand_string(8));
    let token = mint_token(&state.cfg, &id, &identity, false, VIEWER_TOKEN_TTL)?;
    Ok(Json(ViewerTokenResponse {
        token,
        livekit_url: state.cfg.livekit_public_url.clone(),
    }))
}
