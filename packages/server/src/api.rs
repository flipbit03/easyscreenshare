use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use livekit_api::access_token::{AccessToken, VideoGrants};
use livekit_api::services::room::RoomClient;
use rand::distr::{Alphanumeric, SampleString};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{config::Config, AppState, SessionEntry};

/// Random ids are 12 alphanumeric chars ≈ 71 bits.
pub const SESSION_ID_LEN: usize = 12;
const SESSION_SECRET_LEN: usize = 24;
/// Closed-stream PINs: always this many DIGITS, auto-generated per stream.
const PIN_LENGTH: u32 = 4;
/// Wrong-PIN attempts allowed per client per window (brute-force guard).
const PIN_ATTEMPTS_MAX: u32 = 5;
const PIN_ATTEMPTS_WINDOW: Duration = Duration::from_secs(60);
/// A session is considered live for this long after its last heartbeat.
const SESSION_TTL: Duration = Duration::from_secs(20);
const PUBLISHER_TOKEN_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const VIEWER_TOKEN_TTL: Duration = Duration::from_secs(10 * 60);
/// Vanity-name rules: keeps names link-clean and away from control chars.
const NAME_MIN: usize = 3;
const NAME_MAX: usize = 32;
/// Viewer display names: free text, sanitized, bounded.
const DISPLAY_NAME_MAX: usize = 64;

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct CreateSessionRequest {
    /// Optional vanity id (e.g. "cadu" → /s/cadu). First-come, first-served
    /// while live; omitted → a random id.
    pub name: Option<String>,
    /// Public streams need no PIN. Default: closed (PIN required).
    #[serde(default)]
    pub public: bool,
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
    /// Present iff the stream is closed. Speak it to your friends.
    pub pin: Option<String>,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct HeartbeatRequest {
    pub secret: String,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct ViewerTokenRequest {
    /// Required for closed streams.
    pub pin: Option<String>,
    /// Optional display name; server sanitizes and falls back to SomeoneN.
    pub name: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct ViewerTokenResponse {
    pub token: String,
    pub livekit_url: String,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct KickRequest {
    pub secret: String,
    /// LiveKit participant identity of the connection to drop.
    pub identity: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../core/src/generated/")]
pub struct KickResponse {
    /// The rotated PIN (kick ALWAYS rotates — a kick without rotation is
    /// theater, the kicked viewer knows the old PIN). None for public streams.
    pub pin: Option<String>,
    /// Whether LiveKit confirmed dropping the live connection. The rotation
    /// holds either way.
    pub disconnected: bool,
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

fn gen_pin() -> String {
    let max = 10u32.pow(PIN_LENGTH);
    format!(
        "{:0width$}",
        rand::rng().random_range(0..max),
        width = PIN_LENGTH as usize
    )
}

fn valid_name(name: &str) -> bool {
    (NAME_MIN..=NAME_MAX).contains(&name.chars().count())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Display names: strip control chars, collapse whitespace, bound length,
/// fall back to a random SomeoneN.
fn sanitize_display_name(name: Option<String>) -> String {
    let cleaned = name
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        return format!("Someone{}", rand::rng().random_range(1..100));
    }
    cleaned.chars().take(DISPLAY_NAME_MAX).collect()
}

/// Best-effort client key for rate limiting: first X-Forwarded-For entry
/// (set by Caddy in prod), else a shared bucket.
fn client_key(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_owned())
        .unwrap_or_else(|| "local".into())
}

fn mint_token(
    cfg: &Config,
    room: &str,
    identity: &str,
    display_name: &str,
    can_publish: bool,
    ttl: Duration,
) -> Result<String, StatusCode> {
    AccessToken::with_api_key(&cfg.livekit_api_key, &cfg.livekit_api_secret)
        .with_identity(identity)
        .with_name(display_name)
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
    let req = body.map(|b| b.0);
    let public = req.as_ref().map(|r| r.public).unwrap_or(false);
    let requested = req.and_then(|r| r.name);
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
    let pin = (!public).then(gen_pin);
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
                pin: pin.clone(),
                pin_attempts: HashMap::new(),
            },
        );
    }

    let publisher_token = mint_token(
        &state.cfg,
        &id,
        "publisher",
        "publisher",
        true,
        PUBLISHER_TOKEN_TTL,
    )
    .map_err(|s| (s, "token error".into()))?;
    Ok(Json(CreateSessionResponse {
        share_url: format!("{}/s/{}", state.cfg.public_base_url, id),
        session_id: id,
        session_secret: secret,
        publisher_token,
        livekit_url: state.cfg.livekit_public_url.clone(),
        pin,
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

/// PIN outcomes the viewer UI distinguishes: 404 no such stream,
/// 401 pin required, 403 wrong pin, 429 slow down.
pub async fn viewer_token(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<ViewerTokenRequest>>,
) -> Result<Json<ViewerTokenResponse>, StatusCode> {
    let req = body.map(|b| b.0);
    let display_name = sanitize_display_name(req.as_ref().and_then(|r| r.name.clone()));
    {
        let mut sessions = state.sessions.lock().unwrap();
        let entry = match sessions.get_mut(&id) {
            Some(e) if e.last_seen.elapsed() < SESSION_TTL => e,
            _ => return Err(StatusCode::NOT_FOUND),
        };
        if let Some(expected_pin) = &entry.pin {
            let supplied = req.as_ref().and_then(|r| r.pin.as_deref());
            let Some(supplied) = supplied else {
                return Err(StatusCode::UNAUTHORIZED); // pin required
            };
            // Rate limit BEFORE comparing, fixed window per client key.
            let key = client_key(&headers);
            let now = Instant::now();
            let slot = entry.pin_attempts.entry(key).or_insert((0, now));
            if now.duration_since(slot.1) > PIN_ATTEMPTS_WINDOW {
                *slot = (0, now);
            }
            if slot.0 >= PIN_ATTEMPTS_MAX {
                return Err(StatusCode::TOO_MANY_REQUESTS);
            }
            slot.0 += 1;
            if supplied != expected_pin {
                return Err(StatusCode::FORBIDDEN); // wrong pin
            }
        }
    }
    let identity = format!("viewer-{}", rand_string(8));
    let token = mint_token(
        &state.cfg,
        &id,
        &identity,
        &display_name,
        false,
        VIEWER_TOKEN_TTL,
    )?;
    Ok(Json(ViewerTokenResponse {
        token,
        livekit_url: state.cfg.livekit_public_url.clone(),
    }))
}

/// Kick a viewer's live connection AND rotate the PIN (always — the kicked
/// viewer knows the old one). Publisher-only via the session secret.
pub async fn kick(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<KickRequest>,
) -> Result<Json<KickResponse>, StatusCode> {
    let new_pin;
    {
        let mut sessions = state.sessions.lock().unwrap();
        let entry = match sessions.get_mut(&id) {
            Some(e) if e.secret == body.secret => e,
            _ => return Err(StatusCode::FORBIDDEN),
        };
        new_pin = entry.pin.as_ref().map(|_| gen_pin());
        entry.pin = new_pin.clone();
        entry.pin_attempts.clear();
    }
    // Best effort: drop the live connection via LiveKit's server API. The
    // PIN rotation above holds even if this fails.
    let disconnected = {
        let client = RoomClient::with_api_key(
            &state.cfg.livekit_internal_url,
            &state.cfg.livekit_api_key,
            &state.cfg.livekit_api_secret,
        );
        match client.remove_participant(&id, &body.identity).await {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!("remove_participant failed: {e}");
                false
            }
        }
    };
    Ok(Json(KickResponse {
        pin: new_pin,
        disconnected,
    }))
}
