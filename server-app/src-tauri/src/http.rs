use std::net::SocketAddr;

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tauri::AppHandle;
use tokio::net::TcpListener;
use tokio::time::{interval, Duration};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::domain::{CommandDefinition, ExecuteCommandRequest, ExecutionLog, LoginRequest, LoginResponse, ServerEvent};
use crate::state::{CommandCenter, Session};

#[derive(Clone)]
pub struct HttpState {
    pub command_center: CommandCenter,
    pub app_handle: AppHandle,
}

#[derive(Debug, Deserialize)]
struct EventsQuery {
    token: String,
}

pub fn spawn_http_server(command_center: CommandCenter, app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_server(command_center, app_handle).await {
            tracing::error!(?error, "HTTP server terminated");
        }
    });
}

async fn run_server(command_center: CommandCenter, app_handle: AppHandle) -> Result<()> {
    let port = std::env::var("REMOTE_COMMAND_CENTER_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(6280);

    let state = HttpState {
        command_center,
        app_handle,
    };

    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/login", post(login))
        .route("/api/commands", get(list_commands))
        .route("/api/commands/:id/execute", post(execute_command))
        .route("/api/history", get(history))
        .route("/api/events", get(events))
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = ([0, 0, 0, 0], port).into();
    tracing::info!(%addr, "Remote Command Center HTTP server listening");

    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, router).await?;

    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "timestamp": chrono::Utc::now().to_rfc3339(),
    }))
}

async fn login(
    State(state): State<HttpState>,
    Json(payload): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, StatusCode> {
    let session = state
        .command_center
        .login(&payload.username, &payload.password)
        .await
        .map_err(|_| StatusCode::UNAUTHORIZED)?;

    Ok(Json(LoginResponse {
        token: session.token,
        expires_at: session.expires_at,
    }))
}

async fn list_commands(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<Vec<CommandDefinition>>, StatusCode> {
    authorize(&state, &headers).await?;
    let commands = state.command_center.list_commands().await;
    Ok(Json(commands))
}

async fn execute_command(
    State(state): State<HttpState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<ExecuteCommandRequest>,
) -> Result<Json<ExecutionLog>, StatusCode> {
    let session = authorize(&state, &headers).await?;
    let record = state
        .command_center
        .execute_command(&id, body.parameters, session.username, &state.app_handle)
        .await
        .map_err(|error| {
            tracing::error!(?error, "Failed to execute command");
            StatusCode::BAD_REQUEST
        })?;
    Ok(Json(record))
}

async fn history(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ExecutionLog>>, StatusCode> {
    authorize(&state, &headers).await?;
    let records = state.command_center.list_history(Some(100)).await;
    Ok(Json(records))
}

async fn events(
    ws: WebSocketUpgrade,
    State(state): State<HttpState>,
    Query(query): Query<EventsQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    let session = state
        .command_center
        .validate_token(&query.token)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;

    Ok(ws.on_upgrade(move |socket| websocket(socket, state, session)))
}

async fn websocket(socket: WebSocket, state: HttpState, session: Session) {
    let (mut sender, mut receiver) = socket.split();
    let mut broadcast_rx = state.command_center.subscribe();
    let mut heartbeat = interval(Duration::from_secs(30));

    tracing::info!(user = session.username, "WebSocket connection established");

    loop {
        tokio::select! {
            biased;
            message = broadcast_rx.recv() => {
                match message {
                    Ok(event) => {
                        if sender.send(Message::Text(serialize_event(&event))).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        if sender.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if text.eq_ignore_ascii_case("ping") {
                            let _ = sender.send(Message::Text("pong".into())).await;
                        }
                    }
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
            _ = heartbeat.tick() => {
                if sender.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
        }
    }

    tracing::info!(user = session.username, "WebSocket connection closed");
}

async fn authorize(state: &HttpState, headers: &HeaderMap) -> Result<Session, StatusCode> {
    let token = extract_token(headers)?;
    state
        .command_center
        .validate_token(&token)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)
}

fn extract_token(headers: &HeaderMap) -> Result<String, StatusCode> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    if let Some(token) = header.strip_prefix("Bearer ") {
        Ok(token.to_string())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn serialize_event(event: &ServerEvent) -> String {
    serde_json::to_string(event).unwrap_or_else(|_| "{}".into())
}
