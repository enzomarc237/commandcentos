use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use argon2::{password_hash::SaltString, Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::process::Command;
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

use crate::domain::{CommandDefinition, CommandMutation, ExecutionLog, ExecutionStatus, ServerEvent};

const HISTORY_LIMIT: usize = 200;
const SESSION_TTL_HOURS: i64 = 24;
const DEFAULT_ADMIN_USER: &str = "admin";
const DEFAULT_ADMIN_PASSWORD: &str = "admin123";

#[derive(Clone, Debug)]
pub struct CommandCenter {
    inner: Arc<CommandCenterInner>,
}

#[derive(Debug)]
struct CommandCenterInner {
    commands: RwLock<HashMap<String, CommandDefinition>>,
    history: RwLock<Vec<ExecutionLog>>,
    credentials: RwLock<HashMap<String, StoredCredential>>,
    sessions: RwLock<HashMap<String, Session>>,
    broadcaster: broadcast::Sender<ServerEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub token: String,
    pub username: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

impl Session {
    pub fn is_expired(&self) -> bool {
        self.expires_at < Utc::now()
    }
}

#[derive(Debug, Clone)]
struct StoredCredential {
    username: String,
    password_hash: String,
}

impl CommandCenter {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(256);
        let center = Self {
            inner: Arc::new(CommandCenterInner {
                commands: RwLock::new(HashMap::new()),
                history: RwLock::new(Vec::new()),
                credentials: RwLock::new(HashMap::new()),
                sessions: RwLock::new(HashMap::new()),
                broadcaster: tx,
            }),
        };
        tauri::async_runtime::block_on(center.seed_defaults());
        center
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.inner.broadcaster.subscribe()
    }

    pub async fn list_commands(&self) -> Vec<CommandDefinition> {
        let commands = self.inner.commands.read().await;
        let mut list: Vec<_> = commands.values().cloned().collect();
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        list
    }

    pub async fn create_or_update_command(
        &self,
        mutation: CommandMutation,
        app: &AppHandle,
    ) -> Result<CommandDefinition> {
        if mutation.name.trim().is_empty() {
            return Err(anyhow!("Command name is required"));
        }
        if mutation.executable.trim().is_empty() {
            return Err(anyhow!("Executable path is required"));
        }

        let mut commands = self.inner.commands.write().await;
        let now = Utc::now();
        let id = mutation
            .id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let is_new = !commands.contains_key(&id);
        let entry = commands.entry(id.clone()).or_insert_with(|| CommandDefinition {
            id: id.clone(),
            name: mutation.name.clone(),
            executable: mutation.executable.clone(),
            args: Vec::new(),
            description: mutation.description.clone(),
            tags: mutation.tags.clone(),
            allow_arguments: mutation.allow_arguments,
            created_at: now,
            updated_at: now,
        });

        entry.name = mutation.name;
        entry.executable = mutation.executable;
        entry.args = mutation.args;
        entry.description = mutation.description;
        entry.tags = mutation.tags;
        entry.allow_arguments = mutation.allow_arguments;
        if is_new {
            entry.created_at = now;
        }
        entry.updated_at = now;

        let saved = entry.clone();
        drop(commands);

        let event = if is_new {
            ServerEvent::CommandCreated(saved.clone())
        } else {
            ServerEvent::CommandUpdated(saved.clone())
        };
        self.broadcast(event, Some(app)).await;

        Ok(saved)
    }

    pub async fn delete_command(&self, id: &str, app: &AppHandle) -> Result<()> {
        let mut commands = self.inner.commands.write().await;
        let removed = commands.remove(id);
        drop(commands);

        match removed {
            Some(_) => {
                self.broadcast(ServerEvent::CommandDeleted { id: id.to_string() }, Some(app))
                    .await;
                Ok(())
            }
            None => Err(anyhow!("Command not found")),
        }
    }

    pub async fn list_history(&self, limit: Option<usize>) -> Vec<ExecutionLog> {
        let history = self.inner.history.read().await;
        let limit = limit.unwrap_or(50);
        history.iter().take(limit).cloned().collect()
    }

    pub async fn execute_command(
        &self,
        command_id: &str,
        runtime_args: Option<Vec<String>>,
        requested_by: String,
        app: &AppHandle,
    ) -> Result<ExecutionLog> {
        let command = {
            let commands = self.inner.commands.read().await;
            commands
                .get(command_id)
                .cloned()
                .ok_or_else(|| anyhow!("Command not found"))?
        };

        if runtime_args.is_some() && !command.allow_arguments {
            return Err(anyhow!(
                "Command '{}' does not allow runtime parameters",
                command.name
            ));
        }

        let parameters: Vec<String> = runtime_args
            .unwrap_or_else(|| command.args.clone())
            .into_iter()
            .map(|arg| arg.trim().to_string())
            .filter(|arg| !arg.is_empty())
            .collect();
        let mut log = ExecutionLog::new(&command, requested_by.clone(), parameters.clone());
        log.status = ExecutionStatus::Pending;
        log.started_at = Utc::now();

        self.push_history(log.clone()).await;
        self.broadcast(ServerEvent::ExecutionStarted(log.clone()), Some(app)).await;

        let this = self.clone();
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = this
                .perform_execution(log, command, parameters, requested_by, app_handle)
                .await
            {
                tracing::error!(?error, "Failed to execute command");
            }
        });

        Ok(log)
    }

    async fn perform_execution(
        &self,
        mut log: ExecutionLog,
        command: CommandDefinition,
        parameters: Vec<String>,
        requested_by: String,
        app: AppHandle,
    ) -> Result<()> {
        log.status = ExecutionStatus::Running;
        self.update_history(&log).await;
        self.broadcast(ServerEvent::ExecutionUpdated(log.clone()), Some(&app))
            .await;

        let output = Command::new(&command.executable)
            .args(parameters.clone())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await;

        match output {
            Ok(result) => {
                let stdout = String::from_utf8_lossy(&result.stdout).to_string();
                let stderr = String::from_utf8_lossy(&result.stderr).to_string();

                if result.status.success() {
                    log.status = ExecutionStatus::Success;
                } else {
                    log.status = ExecutionStatus::Error;
                    let code = result.status.code().unwrap_or(-1);
                    let message = if stderr.is_empty() {
                        format!("Process exited with status {}", code)
                    } else {
                        format!("Process exited with status {}: {}", code, stderr.trim())
                    };
                    log.error = Some(message);
                }

                log.output = if stdout.is_empty() {
                    stderr
                } else {
                    stdout
                };
            }
            Err(err) => {
                log.status = ExecutionStatus::Error;
                log.error = Some(err.to_string());
            }
        }

        log.finished_at = Some(Utc::now());
        log.requested_by = requested_by;
        log.parameters = parameters;

        self.update_history(&log).await;
        self.broadcast(ServerEvent::ExecutionFinished(log), Some(&app)).await;

        Ok(())
    }

    async fn push_history(&self, record: ExecutionLog) {
        let mut history = self.inner.history.write().await;
        history.insert(0, record);
        if history.len() > HISTORY_LIMIT {
            history.truncate(HISTORY_LIMIT);
        }
    }

    async fn update_history(&self, record: &ExecutionLog) {
        let mut history = self.inner.history.write().await;
        if let Some(position) = history.iter().position(|item| item.id == record.id) {
            history[position] = record.clone();
        } else {
            history.insert(0, record.clone());
            if history.len() > HISTORY_LIMIT {
                history.truncate(HISTORY_LIMIT);
            }
        }
    }

    async fn broadcast(&self, event: ServerEvent, app: Option<&AppHandle>) {
        if let Some(handle) = app {
            let _ = handle.emit_all("command-center://event", &event);
        }
        let _ = self.inner.broadcaster.send(event);
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<Session> {
        let credential = {
            let credentials = self.inner.credentials.read().await;
            credentials
                .get(username)
                .cloned()
                .ok_or_else(|| anyhow!("Invalid username or password"))?
        };

        verify_password(password, &credential.password_hash)
            .map_err(|_| anyhow!("Invalid username or password"))?;

        let now = Utc::now();
        let session = Session {
            token: Uuid::new_v4().to_string(),
            username: credential.username,
            created_at: now,
            expires_at: now + ChronoDuration::hours(SESSION_TTL_HOURS),
        };

        let mut sessions = self.inner.sessions.write().await;
        sessions.insert(session.token.clone(), session.clone());

        Ok(session)
    }

    pub async fn validate_token(&self, token: &str) -> Option<Session> {
        self.cleanup_sessions().await;
        let sessions = self.inner.sessions.read().await;
        sessions.get(token).cloned()
    }

    pub async fn set_password(&self, username: String, password: String) -> Result<()> {
        if username.trim().is_empty() {
            return Err(anyhow!("Username is required"));
        }
        if password.trim().is_empty() {
            return Err(anyhow!("Password is required"));
        }
        let hash = hash_password(&password)?;
        let mut credentials = self.inner.credentials.write().await;
        credentials.insert(
            username.clone(),
            StoredCredential {
                username,
                password_hash: hash,
            },
        );
        Ok(())
    }

    pub async fn active_sessions(&self) -> Vec<Session> {
        self.cleanup_sessions().await;
        let sessions = self.inner.sessions.read().await;
        sessions.values().cloned().collect()
    }

    async fn seed_defaults(&self) {
        let mut credentials = self.inner.credentials.write().await;
        if !credentials.contains_key(DEFAULT_ADMIN_USER) {
            if let Ok(hash) = hash_password(DEFAULT_ADMIN_PASSWORD) {
                credentials.insert(
                    DEFAULT_ADMIN_USER.to_string(),
                    StoredCredential {
                        username: DEFAULT_ADMIN_USER.to_string(),
                        password_hash: hash,
                    },
                );
            }
        }
        drop(credentials);

        if self.inner.commands.read().await.is_empty() {
            let mut commands = self.inner.commands.write().await;
            let now = Utc::now();
            let mut register_command = |name: &str, executable: &str, args: &[&str], description: &str| {
                let mut command = CommandDefinition::new(name.to_string(), executable.to_string());
                command.args = args.iter().map(|item| item.to_string()).collect();
                command.description = Some(description.to_string());
                command.tags = vec!["sample".to_string()];
                command.created_at = now;
                command.updated_at = now;
                commands.insert(command.id.clone(), command);
            };

            register_command(
                "List running processes",
                "/bin/ps",
                &["aux"],
                "Returns the current process list",
            );
            register_command(
                "Ping remote host",
                "/sbin/ping",
                &["-c", "4", "127.0.0.1"],
                "Runs a connectivity test to the specified host",
            );
        }
    }

    async fn cleanup_sessions(&self) {
        let mut sessions = self.inner.sessions.write().await;
        let now = Utc::now();
        sessions.retain(|_, session| session.expires_at > now);
    }
}

fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon = Argon2::default();
    Ok(
        argon
            .hash_password(password.as_bytes(), &salt)
            .map_err(|err| anyhow!("Hash failure: {}", err))?
            .to_string(),
    )
}

fn verify_password(password: &str, hash: &str) -> Result<()> {
    let parsed = PasswordHash::new(hash).context("Invalid password hash")?;
    let argon = Argon2::default();
    argon
        .verify_password(password.as_bytes(), &parsed)
        .map_err(|_| anyhow!("Invalid username or password"))
}
