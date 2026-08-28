use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::Engine;
use easyscreenshare_server::{build_router, config::Config};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;

fn test_config() -> Config {
    Config {
        port: 0,
        livekit_api_key: "devkey".into(),
        livekit_api_secret: "secret".into(),
        livekit_public_url: "ws://localhost:7880".into(),
        // Unreachable on purpose: kick's LiveKit call must fail gracefully.
        livekit_internal_url: "http://127.0.0.1:1".into(),
        public_base_url: "http://test.local".into(),
        static_dir: "does-not-exist".into(),
    }
}

fn app() -> axum::Router {
    build_router(test_config())
}

fn jwt_claims(jwt: &str) -> serde_json::Value {
    let payload = jwt.split('.').nth(1).expect("jwt has three parts");
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .expect("valid base64url payload");
    serde_json::from_slice(&bytes).expect("valid json claims")
}

async fn send(router: &axum::Router, req: Request<Body>) -> (StatusCode, serde_json::Value) {
    let res = router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    (status, json)
}

fn post_json(path: &str, body: serde_json::Value) -> Request<Body> {
    Request::post(path)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn create_random() -> Request<Body> {
    Request::post("/api/sessions").body(Body::empty()).unwrap()
}

#[tokio::test]
async fn create_session_mints_publish_only_token() {
    let app = app();
    let (status, json) = send(&app, create_random()).await;
    assert_eq!(status, StatusCode::OK);

    let id = json["sessionId"].as_str().unwrap();
    assert_eq!(id.len(), 12);
    assert!(!json["sessionSecret"].as_str().unwrap().is_empty());
    assert_eq!(
        json["shareUrl"].as_str().unwrap(),
        format!("http://test.local/s/{id}")
    );

    let claims = jwt_claims(json["publisherToken"].as_str().unwrap());
    assert_eq!(claims["video"]["room"], id);
    assert_eq!(claims["video"]["canPublish"], true);
    assert_eq!(claims["video"]["canSubscribe"], false);
}

#[tokio::test]
async fn viewer_token_404_for_unknown_session() {
    // A dead/never-created link must 404, not hand out a token.
    let app = app();
    let (status, _) = send(
        &app,
        post_json("/api/sessions/AbC123xYz456/token", json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn closed_stream_pin_flow() {
    let app = app();
    // Default = closed: the response carries a 4-digit pin.
    let (_, created) = send(&app, create_random()).await;
    let id = created["sessionId"].as_str().unwrap().to_owned();
    let pin = created["pin"].as_str().unwrap().to_owned();
    assert_eq!(pin.len(), 4);
    assert!(pin.chars().all(|c| c.is_ascii_digit()));

    // No pin -> 401 (pin required).
    let (s, _) = send(
        &app,
        post_json(&format!("/api/sessions/{id}/token"), json!({})),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    // Wrong pin -> 403.
    let (s, _) = send(
        &app,
        post_json(
            &format!("/api/sessions/{id}/token"),
            json!({"pin": "0000x"}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // Correct pin -> token, name stamped.
    let (s, json) = send(
        &app,
        post_json(
            &format!("/api/sessions/{id}/token"),
            json!({"pin": pin, "name": "Cadu"}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let claims = jwt_claims(json["token"].as_str().unwrap());
    assert_eq!(claims["name"], "Cadu");
    assert_eq!(claims["video"]["canPublish"], false);
}

#[tokio::test]
async fn wrong_pin_rate_limited() {
    let app = app();
    let (_, created) = send(&app, create_random()).await;
    let id = created["sessionId"].as_str().unwrap().to_owned();
    for _ in 0..5 {
        let (s, _) = send(
            &app,
            post_json(&format!("/api/sessions/{id}/token"), json!({"pin": "XXXX"})),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }
    // 6th attempt in the window -> throttled, even with the RIGHT pin.
    let pin = created["pin"].as_str().unwrap();
    let (s, _) = send(
        &app,
        post_json(&format!("/api/sessions/{id}/token"), json!({"pin": pin})),
    )
    .await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn public_stream_needs_no_pin() {
    let app = app();
    let (_, created) = send(&app, post_json("/api/sessions", json!({"public": true}))).await;
    assert!(created["pin"].is_null());
    let id = created["sessionId"].as_str().unwrap();
    let (s, json) = send(
        &app,
        post_json(&format!("/api/sessions/{id}/token"), json!({})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    // No name given -> server invents SomeoneN.
    let claims = jwt_claims(json["token"].as_str().unwrap());
    assert!(claims["name"].as_str().unwrap().starts_with("Someone"));
}

#[tokio::test]
async fn kick_rotates_pin_and_requires_secret() {
    let app = app();
    let (_, created) = send(&app, create_random()).await;
    let id = created["sessionId"].as_str().unwrap().to_owned();
    let secret = created["sessionSecret"].as_str().unwrap().to_owned();
    let old_pin = created["pin"].as_str().unwrap().to_owned();

    // Wrong secret -> forbidden.
    let (s, _) = send(
        &app,
        post_json(
            &format!("/api/sessions/{id}/kick"),
            json!({"secret": "nope", "identity": "viewer-x"}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    // Right secret -> pin rotates (LiveKit disconnect is best-effort false
    // in tests, since no LiveKit is running).
    let (s, json) = send(
        &app,
        post_json(
            &format!("/api/sessions/{id}/kick"),
            json!({"secret": secret, "identity": "viewer-x"}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let new_pin = json["pin"].as_str().unwrap();
    assert_eq!(new_pin.len(), 4);
    assert_ne!(new_pin, old_pin);

    // Old pin no longer admits.
    let (s, _) = send(
        &app,
        post_json(
            &format!("/api/sessions/{id}/token"),
            json!({"pin": old_pin}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn vanity_name_is_claimed_first_come_first_served() {
    let app = app();
    let (s1, _) = send(&app, post_json("/api/sessions", json!({ "name": "cadu" }))).await;
    assert_eq!(s1, StatusCode::OK);
    // Second claim while the first is live → conflict.
    let (s2, _) = send(&app, post_json("/api/sessions", json!({ "name": "cadu" }))).await;
    assert_eq!(s2, StatusCode::CONFLICT);
    // A viewer can join the claimed name (with its pin).
    let (_, created) = send(&app, post_json("/api/sessions", json!({ "name": "cadu2" }))).await;
    let pin = created["pin"].as_str().unwrap();
    let (status, _) = send(
        &app,
        post_json("/api/sessions/cadu2/token", json!({"pin": pin})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn invalid_vanity_names_rejected() {
    let app = app();
    for bad in [
        "ab",
        "has space",
        "waaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaay-too-long",
        "dot.dot",
    ] {
        let (status, _) = send(&app, post_json("/api/sessions", json!({ "name": bad }))).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "name {bad:?} must be rejected"
        );
    }
}

#[tokio::test]
async fn heartbeat_requires_matching_secret() {
    let app = app();
    let (_, created) = send(&app, post_json("/api/sessions", json!({ "name": "beat" }))).await;
    let secret = created["sessionSecret"].as_str().unwrap();

    let (bad, _) = send(
        &app,
        post_json("/api/sessions/beat/heartbeat", json!({ "secret": "wrong" })),
    )
    .await;
    assert_eq!(bad, StatusCode::FORBIDDEN);

    let (ok, _) = send(
        &app,
        post_json("/api/sessions/beat/heartbeat", json!({ "secret": secret })),
    )
    .await;
    assert_eq!(ok, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn healthz_ok() {
    let app = app();
    let req = Request::get("/healthz").body(Body::empty()).unwrap();
    let (status, _) = send(&app, req).await;
    assert_eq!(status, StatusCode::OK);
}
