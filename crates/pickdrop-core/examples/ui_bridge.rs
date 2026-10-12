//! Local test harness for connecting the production web UI to the real Rust
//! core. This binary is never packaged in the app and listens on loopback only.
use axum::{
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use futures_util::stream;
use pickdrop_core::Core;
use serde_json::{json, Value};
use std::{convert::Infallible, path::PathBuf};

async fn call(State(core): State<Core>, Json(body): Json<Value>) -> Json<Value> {
    match core
        .dispatch(
            body["method"].as_str().unwrap_or(""),
            body["params"].clone(),
        )
        .await
    {
        Ok(value) => Json(json!({"ok":true,"value":value})),
        Err(error) => Json(json!({"ok":false,"error":error.to_string()})),
    }
}
async fn events(
    State(core): State<Core>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    Sse::new(stream::unfold(
        core.subscribe(),
        |mut receiver| async move {
            loop {
                match receiver.recv().await {
                    Ok(value) => {
                        return Some((Ok(Event::default().data(value.to_string())), receiver))
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return None,
                }
            }
        },
    ))
    .keep_alive(KeepAlive::default())
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().expect("data directory"));
    let port = args.next().unwrap_or("0".into()).parse::<u16>()?;
    let core = Core::open(dir, "desktop").await?;
    let router = Router::new()
        .route("/call", post(call))
        .route("/events", get(events))
        .with_state(core);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!("{}", listener.local_addr()?);
    axum::serve(listener, router).await?;
    Ok(())
}
