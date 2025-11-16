#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod domain;
mod http;
mod state;

use domain::{CommandDefinition, CommandMutation, ExecutionLog};
use http::spawn_http_server;
use serde::Deserialize;
use state::{CommandCenter, Session};
use tauri::{AppHandle, CustomMenuItem, Manager, State, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Deserialize)]
struct SaveCommandArgs {
    id: Option<String>,
    name: String,
    executable: String,
    #[serde(default)]
    args: Vec<String>,
    description: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default = "default_allow_arguments")]
    #[serde(rename = "allow_arguments")]
    allow_arguments: bool,
}

#[derive(Debug, Deserialize)]
struct ExecuteArgs {
    id: String,
    args: Option<Vec<String>>,
    requested_by: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PasswordArgs {
    username: String,
    password: String,
}

fn default_allow_arguments() -> bool {
    true
}

#[tauri::command]
async fn list_commands(state: State<'_, CommandCenter>) -> Result<Vec<CommandDefinition>, String> {
    Ok(state.list_commands().await)
}

#[tauri::command]
async fn list_history(
    state: State<'_, CommandCenter>,
    limit: Option<usize>,
) -> Result<Vec<ExecutionLog>, String> {
    Ok(state.list_history(limit).await)
}

#[tauri::command]
async fn create_or_update_command(
    app: AppHandle,
    state: State<'_, CommandCenter>,
    payload: SaveCommandArgs,
) -> Result<CommandDefinition, String> {
    let mutation = CommandMutation {
        id: payload.id,
        name: payload.name,
        executable: payload.executable,
        args: payload
            .args
            .into_iter()
            .map(|arg| arg.trim().to_string())
            .filter(|arg| !arg.is_empty())
            .collect(),
        description: payload.description.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }),
        tags: payload
            .tags
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .collect(),
        allow_arguments: payload.allow_arguments,
    };

    state
        .create_or_update_command(mutation, &app)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn delete_command(app: AppHandle, state: State<'_, CommandCenter>, id: String) -> Result<(), String> {
    state
        .delete_command(&id, &app)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn execute_command(
    app: AppHandle,
    state: State<'_, CommandCenter>,
    payload: ExecuteArgs,
) -> Result<ExecutionLog, String> {
    let requested_by = payload
        .requested_by
        .unwrap_or_else(|| "tauri-operator".to_string());
    state
        .execute_command(&payload.id, payload.args, requested_by, &app)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn set_password(state: State<'_, CommandCenter>, payload: PasswordArgs) -> Result<(), String> {
    state
        .set_password(payload.username, payload.password)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn active_sessions(state: State<'_, CommandCenter>) -> Result<Vec<Session>, String> {
    Ok(state.active_sessions().await)
}

fn main() {
    init_tracing();
    let command_center = CommandCenter::new();
    let tray = build_system_tray();

    tauri::Builder::default()
        .manage(command_center.clone())
        .setup(|app| {
            let center = app.state::<CommandCenter>().inner().clone();
            let handle = app.handle();
            spawn_http_server(center, handle.clone());

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .system_tray(tray)
        .on_system_tray_event(handle_tray_event)
        .invoke_handler(tauri::generate_handler![
            list_commands,
            list_history,
            create_or_update_command,
            delete_command,
            execute_command,
            set_password,
            active_sessions
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tauri application");
}

fn init_tracing() {
    let filter = std::env::var("RCC_LOG").unwrap_or_else(|_| "info".into());
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new(filter))
        .with_target(false)
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
}

fn build_system_tray() -> SystemTray {
    let show = CustomMenuItem::new("show".to_string(), "Show Console");
    let hide = CustomMenuItem::new("hide".to_string(), "Hide Console");
    let quit = CustomMenuItem::new("quit".to_string(), "Quit");

    let menu = SystemTrayMenu::new()
        .add_item(show)
        .add_item(hide)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);

    SystemTray::new().with_menu(menu)
}

fn handle_tray_event(app: &tauri::AppHandle, event: SystemTrayEvent) {
    match event {
        SystemTrayEvent::LeftClick { .. } => toggle_main_window(app),
        SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
            "show" => show_main_window(app),
            "hide" => hide_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        },
        _ => {}
    }
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.hide();
    }
}
