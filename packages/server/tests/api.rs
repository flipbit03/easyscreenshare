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
    let req = Request::get("/api/sessions/AbC123xYz456/token")
        .body(Body::empty())
        .unwrap();
    let (status, _) = send(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn viewer_token_works_after_session_created() {
    let app = app();
    let (_, created) = send(&app, create_random()).await;
    let id = created["sessionId"].as_str().unwrap();

    let req = Request::get(format!("/api/sessions/{id}/token"))
        .body(Body::empty())
        .unwrap();
    let (status, json) = send(&app, req).await;
    assert_eq!(status, StatusCode::OK);
    let claims = jwt_claims(json["token"].as_str().unwrap());
    assert_eq!(
        claims["video"]["canPublish"], false,
        "viewer must NEVER publish"
    );
    assert_eq!(claims["video"]["canSubscribe"], true);
}

#[tokio::test]
async fn vanity_name_is_claimed_first_come_first_served() {
    let app = app();
    let (s1, _) = send(&app, post_json("/api/sessions", json!({ "name": "cadu" }))).await;
    assert_eq!(s1, StatusCode::OK);
    // Second claim while the first is live → conflict.
    let (s2, _) = send(&app, post_json("/api/sessions", json!({ "name": "cadu" }))).await;
    assert_eq!(s2, StatusCode::CONFLICT);
    // A viewer can join the claimed name.
    let req = Request::get("/api/sessions/cadu/token")
        .body(Body::empty())
        .unwrap();
    let (status, _) = send(&app, req).await;
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
