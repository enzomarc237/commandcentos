use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDefinition {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub args: Vec<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub allow_arguments: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl CommandDefinition {
    pub fn new(name: String, executable: String) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            executable,
            args: Vec::new(),
            description: None,
            tags: Vec::new(),
            allow_arguments: true,
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandMutation {
    pub id: Option<String>,
    pub name: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_allow_arguments")]
    pub allow_arguments: bool,
}

fn default_allow_arguments() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionStatus {
    Pending,
    Running,
    Success,
    Error,
}

impl ExecutionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ExecutionStatus::Pending => "pending",
            ExecutionStatus::Running => "running",
            ExecutionStatus::Success => "success",
            ExecutionStatus::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionLog {
    pub id: String,
    pub command_id: String,
    pub command_name: String,
    pub requested_by: String,
    pub status: ExecutionStatus,
    pub output: String,
    pub error: Option<String>,
    pub parameters: Vec<String>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

impl ExecutionLog {
    pub fn new(command: &CommandDefinition, requested_by: String, parameters: Vec<String>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            command_id: command.id.clone(),
            command_name: command.name.clone(),
            requested_by,
            status: ExecutionStatus::Pending,
            output: String::new(),
            error: None,
            parameters,
            started_at: Utc::now(),
            finished_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ServerEvent {
    #[serde(rename = "command_created")]
    CommandCreated(CommandDefinition),
    #[serde(rename = "command_updated")]
    CommandUpdated(CommandDefinition),
    #[serde(rename = "command_deleted")]
    CommandDeleted { id: String },
    #[serde(rename = "execution_started")]
    ExecutionStarted(ExecutionLog),
    #[serde(rename = "execution_updated")]
    ExecutionUpdated(ExecutionLog),
    #[serde(rename = "execution_finished")]
    ExecutionFinished(ExecutionLog),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub token: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteCommandRequest {
    pub parameters: Option<Vec<String>>,
}
