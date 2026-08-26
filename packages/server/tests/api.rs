use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::Engine;
use easyscreenshare_server::{build_router, config::Config};
use http_body_util::BodyExt;
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

fn jwt_claims(jwt: &str) -> serde_json::Value {
    let payload = jwt.split('.').nth(1).expect("jwt has three parts");
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .expect("valid base64url payload");
    serde_json::from_slice(&bytes).expect("valid json claims")
}

async fn body_json(req: Request<Body>) -> (StatusCode, serde_json::Value) {
    let res = build_router(test_config()).oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    (status, json)
}

fn post_sessions() -> Request<Body> {
    Request::post("/api/sessions").body(Body::empty()).unwrap()
}

#[tokio::test]
async fn create_session_mints_publish_only_token() {
    let (status, json) = body_json(post_sessions()).await;
    assert_eq!(status, StatusCode::OK);

    let id = json["sessionId"].as_str().unwrap();
    assert_eq!(id.len(), 12);
    assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
    assert_eq!(
        json["shareUrl"].as_str().unwrap(),
        format!("http://test.local/s/{id}")
    );
    assert_eq!(json["livekitUrl"].as_str().unwrap(), "ws://localhost:7880");

    let claims = jwt_claims(json["publisherToken"].as_str().unwrap());
    assert_eq!(claims["iss"], "devkey");
    assert_eq!(claims["sub"], "publisher");
    let video = &claims["video"];
    assert_eq!(video["room"], id);
    assert_eq!(video["roomJoin"], true);
    assert_eq!(video["canPublish"], true);
    assert_eq!(video["canSubscribe"], false, "publisher must not subscribe");

    // Publisher token must outlive a long stream (~12h).
    let lifetime = claims["exp"].as_i64().unwrap() - claims["nbf"].as_i64().unwrap();
    assert!(
        lifetime >= 11 * 3600,
        "publisher ttl too short: {lifetime}s"
    );
}

#[tokio::test]
async fn viewer_token_is_subscribe_only_and_short_lived() {
    let req = Request::get("/api/sessions/AbC123xYz456/token")
        .body(Body::empty())
        .unwrap();
    let (status, json) = body_json(req).await;
    assert_eq!(status, StatusCode::OK);

    let claims = jwt_claims(json["token"].as_str().unwrap());
    assert!(claims["sub"].as_str().unwrap().starts_with("viewer-"));
    let video = &claims["video"];
    assert_eq!(video["room"], "AbC123xYz456");
    assert_eq!(video["roomJoin"], true);
    assert_eq!(video["canPublish"], false, "viewer must NEVER publish");
    assert_eq!(video["canSubscribe"], true);

    // Viewer tokens are throwaway: minutes, not hours.
    let lifetime = claims["exp"].as_i64().unwrap() - claims["nbf"].as_i64().unwrap();
    assert!(lifetime <= 15 * 60, "viewer ttl too long: {lifetime}s");
}

#[tokio::test]
async fn viewer_token_rejects_malformed_ids() {
    for bad in ["short", "way-too-long-to-be-valid", "has.dots.in12"] {
        let req = Request::get(format!("/api/sessions/{bad}/token"))
            .body(Body::empty())
            .unwrap();
        let (status, _) = body_json(req).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "id {bad:?} must 404");
    }
}

#[tokio::test]
async fn session_ids_are_unique() {
    let (_, a) = body_json(post_sessions()).await;
    let (_, b) = body_json(post_sessions()).await;
    assert_ne!(a["sessionId"], b["sessionId"]);
}

#[tokio::test]
async fn healthz_ok() {
    let req = Request::get("/healthz").body(Body::empty()).unwrap();
    let res = build_router(test_config()).oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}
