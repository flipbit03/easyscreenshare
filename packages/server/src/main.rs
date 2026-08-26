use axum::{routing::get, Router};

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8090);

    let app = Router::new().route("/healthz", get(|| async { "ok" }));

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("failed to bind");
    println!("listening on :{port}");
    axum::serve(listener, app).await.expect("server error");
}
