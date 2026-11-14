use super::{AiError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const MAX_REQUEST: usize = 128 * 1024;
pub const MAX_RESPONSE: usize = 512 * 1024;
pub const MODELS: [&str; 2] = ["deepseek-flash", "deepseek-v4-pro"];

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WireCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionCall,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "role", rename_all = "lowercase", deny_unknown_fields)]
pub enum Message {
    System {
        content: String,
    },
    User {
        content: String,
    },
    Assistant {
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<WireCall>,
    },
    Tool {
        content: String,
        tool_call_id: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Function {
    name: String,
    description: String,
    parameters: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Tool {
    #[serde(rename = "type")]
    kind: String,
    function: Function,
}

fn function_name(name: &str) -> bool {
    let Some((prefix, rest)) = name.split_once('_') else {
        return false;
    };
    !prefix.is_empty()
        && !rest.is_empty()
        && name.len() <= 64
        && prefix.bytes().all(|c| c.is_ascii_lowercase())
        && rest.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
}

fn short_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 200 && value.bytes().all(|c| c.is_ascii_graphic())
}

pub fn request_body(value: Value) -> Result<(String, Vec<u8>)> {
    if serde_json::to_vec(&value)
        .map_err(|_| AiError::bad())?
        .len()
        > MAX_REQUEST
    {
        return Err(AiError::large());
    }
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .filter(|m| MODELS.contains(m))
        .ok_or_else(AiError::bad)?
        .to_owned();
    let messages: Vec<Message> =
        serde_json::from_value(value.get("messages").cloned().ok_or_else(AiError::bad)?)
            .map_err(|_| AiError::bad())?;
    if messages.is_empty() || messages.len() > 40 {
        return Err(AiError::large());
    }
    for message in &messages {
        let content = match message {
            Message::System { content } | Message::User { content } => Some(content),
            Message::Assistant {
                content,
                tool_calls,
            } => {
                if content.is_none() && tool_calls.is_empty() {
                    return Err(AiError::bad());
                }
                for call in tool_calls {
                    if call.kind != "function"
                        || !short_id(&call.id)
                        || !function_name(&call.function.name)
                        || call.function.arguments.chars().count() > 8_000
                    {
                        return Err(AiError::bad());
                    }
                }
                content.as_ref()
            }
            Message::Tool {
                content,
                tool_call_id,
            } => {
                if !short_id(tool_call_id) {
                    return Err(AiError::bad());
                }
                Some(content)
            }
        };
        if content.is_some_and(|c| c.chars().count() > 8_000) {
            return Err(AiError::large());
        }
    }
    let tools: Vec<Tool> =
        serde_json::from_value(value.get("tools").cloned().unwrap_or_else(|| json!([])))
            .map_err(|_| AiError::bad())?;
    if tools.len() > 32 {
        return Err(AiError::large());
    }
    let mut names = std::collections::HashSet::new();
    for tool in &tools {
        let schema = &tool.function.parameters;
        if tool.kind != "function"
            || !function_name(&tool.function.name)
            || !names.insert(&tool.function.name)
            || tool.function.description.chars().count() > 300
            || schema.get("type").and_then(Value::as_str) != Some("object")
            || !schema.get("properties").is_some_and(Value::is_object)
            || schema.get("additionalProperties") != Some(&json!(false))
        {
            return Err(AiError::bad());
        }
    }
    let mut body = json!({ "model": model, "messages": messages,
        "max_tokens": 800, "stream": false, "thinking": { "type": "disabled" } });
    // 空登记表时不发 tools / tool_choice，兼容 A2 只有文字的对话。
    if !tools.is_empty() {
        body["tools"] = serde_json::to_value(tools).map_err(|_| AiError::bad())?;
        body["tool_choice"] = json!("auto");
    }
    let bytes = serde_json::to_vec(&body).map_err(|_| AiError::bad())?;
    if bytes.len() > MAX_REQUEST {
        return Err(AiError::large());
    }
    Ok((model, bytes))
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub content: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub usage: TokenUsage,
}

// 响应只读取必要字段，兼容上游附带的元数据；请求类型仍保持严格。
#[derive(Deserialize)]
struct ResponseFunction {
    name: String,
    arguments: String,
}

#[derive(Deserialize)]
struct ResponseCall {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    function: ResponseFunction,
}

pub fn normalize_response(bytes: &[u8]) -> Result<ChatResponse> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| AiError::bad())?;
    let choices = value
        .get("choices")
        .and_then(Value::as_array)
        .filter(|c| c.len() == 1)
        .ok_or_else(AiError::bad)?;
    let choice = &choices[0];
    // 截断的工具参数或被过滤的结果不可当成完整的操作提案。
    if !matches!(
        choice.get("finish_reason").and_then(Value::as_str),
        Some("stop" | "tool_calls")
    ) {
        return Err(AiError::bad());
    }
    let message = choice.get("message").ok_or_else(AiError::bad)?;
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return Err(AiError::bad());
    }
    let content = match message.get("content") {
        Some(Value::String(text)) if text.chars().count() <= 32_000 => Some(text.clone()),
        Some(Value::Null) => None,
        _ => return Err(AiError::bad()),
    };
    let calls: Vec<ResponseCall> = match message.get("tool_calls") {
        None | Some(Value::Null) => vec![],
        Some(calls) => serde_json::from_value(calls.clone()).map_err(|_| AiError::bad())?,
    };
    if calls.len() > 128 || (content.is_none() && calls.is_empty()) {
        return Err(AiError::bad());
    }
    let mut ids = std::collections::HashSet::new();
    let mut tool_calls = Vec::new();
    for call in calls {
        if call.kind != "function"
            || !short_id(&call.id)
            || !ids.insert(call.id.clone())
            || call.function.name.len() > 200
            || call.function.arguments.chars().count() > 8_000
        {
            return Err(AiError::bad());
        }
        tool_calls.push(ToolCall {
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
        });
    }
    let usage: TokenUsage =
        serde_json::from_value(value.get("usage").cloned().ok_or_else(AiError::bad)?)
            .map_err(|_| AiError::bad())?;
    Ok(ChatResponse {
        content,
        tool_calls,
        usage,
    })
}
