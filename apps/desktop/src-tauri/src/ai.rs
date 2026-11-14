mod protocol;
#[cfg(test)]
mod tests;
mod usage;

use protocol::{ChatResponse, MAX_RESPONSE, normalize_response, request_body};
use reqwest::{Client, Method, Url, header};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_shell::ShellExt;
use usage::{Usage, UsageStore, audit, now};

const BASE_URL: &str = "https://api.deepseek.com";
type Result<T> = std::result::Result<T, AiError>;

#[derive(Clone, Debug, Serialize)]
pub struct AiError {
    code: &'static str,
    message: &'static str,
}

impl AiError {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
    fn bad() -> Self {
        Self::new(
            "BAD_RESPONSE",
            "AI 返回的内容或请求参数无法解析，请手动新建或换个说法",
        )
    }
    fn large() -> Self {
        Self::new("TOO_LARGE", "这句话或上下文太长了，请缩短")
    }
    fn storage() -> Self {
        Self::new(
            "STORAGE_ERROR",
            "无法保存 AI 用量，已停止发送，请检查应用数据目录后重试",
        )
    }
    fn credential() -> Self {
        Self::new(
            "CREDENTIAL_ERROR",
            "无法访问系统凭据，请检查 Windows 凭据管理器",
        )
    }
}

fn main_only(label: &str) -> Result<()> {
    if label == "main" {
        Ok(())
    } else {
        Err(AiError::new("FORBIDDEN", "只有主窗口可以访问 AI 服务"))
    }
}

// 不派生 Debug，任何调试输出也不能泄露密钥。
struct ApiKey(String);
impl std::fmt::Debug for ApiKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ApiKey([已隐藏])")
    }
}
impl ApiKey {
    fn parse(value: &str) -> Result<Self> {
        let key = value.trim();
        if !(20..=200).contains(&key.len()) || !key.bytes().all(|c| c.is_ascii_graphic()) {
            return Err(AiError::new(
                "KEY_FORMAT",
                "API key 需为 20–200 个可见 ASCII 字符",
            ));
        }
        Ok(Self(key.to_owned()))
    }
}

fn credential(app: &AppHandle) -> Result<keyring::Entry> {
    keyring::Entry::new(&format!("{}.ai", app.config().identifier), "deepseek")
        .map_err(|_| AiError::credential())
}
fn read_key(app: &AppHandle) -> Result<Option<ApiKey>> {
    match credential(app)?.get_password() {
        Ok(value) => Ok(Some(ApiKey::parse(&value)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(AiError::credential()),
    }
}

#[derive(Default)]
pub struct AiState {
    busy: AtomicBool,
    usage: Mutex<Option<UsageStore>>,
}

struct InFlight<'a>(&'a AtomicBool);
impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl AiState {
    fn acquire(&self) -> Result<InFlight<'_>> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| AiError::new("BUSY", "上一句还在处理，请稍后再试"))?;
        Ok(InFlight(&self.busy))
    }
    fn with_usage<T>(
        &self,
        app: &AppHandle,
        action: impl FnOnce(&mut UsageStore) -> Result<T>,
    ) -> Result<T> {
        let mut lock = self.usage.lock().map_err(|_| AiError::storage())?;
        if lock.is_none() {
            *lock = Some(UsageStore::load(&data_directory(app)?, now())?);
        }
        action(lock.as_mut().ok_or_else(AiError::storage)?)
    }
}

fn data_directory(app: &AppHandle) -> Result<PathBuf> {
    app.path().app_data_dir().map_err(|_| AiError::storage())
}

pub fn setup(app: &AppHandle) {
    // AI 存储失败不阻断综合、金融工作台；命令调用时仍会重新尝试并返回明确错误。
    if let Err(error) = app.state::<AiState>().with_usage(app, |_| Ok(())) {
        if let Ok(path) = data_directory(app) {
            audit(&path, &format!("startup code={}", error.code));
        }
    }
}

#[derive(Serialize)]
pub struct KeyStatus {
    configured: bool,
    tail: Option<String>,
    usage: Usage,
}

fn key_status(key: Option<&ApiKey>, usage: Usage) -> KeyStatus {
    KeyStatus {
        configured: key.is_some(),
        tail: key.map(|key| key.0[key.0.len() - 4..].to_owned()),
        usage,
    }
}

#[tauri::command]
pub fn ai_key_set(window: WebviewWindow, key: String) -> Result<KeyStatus> {
    main_only(window.label())?;
    let key = ApiKey::parse(&key)?;
    credential(window.app_handle())?
        .set_password(&key.0)
        .map_err(|_| AiError::credential())?;
    let usage = window
        .state::<AiState>()
        .with_usage(window.app_handle(), |store| Ok(store.snapshot(now())))?;
    Ok(key_status(Some(&key), usage))
}

#[tauri::command]
pub fn ai_key_status(window: WebviewWindow) -> Result<KeyStatus> {
    main_only(window.label())?;
    let key = read_key(window.app_handle())?;
    let usage = window
        .state::<AiState>()
        .with_usage(window.app_handle(), |store| Ok(store.snapshot(now())))?;
    Ok(key_status(key.as_ref(), usage))
}

#[tauri::command]
pub fn ai_key_clear(window: WebviewWindow) -> Result<()> {
    main_only(window.label())?;
    match credential(window.app_handle())?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(AiError::credential()),
    }
}

#[tauri::command]
pub fn ai_open_platform(window: WebviewWindow) -> Result<()> {
    main_only(window.label())?;
    // 固定地址，不接受来自前端的任意 URL；复用现有 shell 插件，不添加依赖。
    #[allow(deprecated)]
    window
        .app_handle()
        .shell()
        .open("https://platform.deepseek.com/", None)
        .map_err(|_| AiError::new("NETWORK", "无法打开系统浏览器，请稍后重试"))
}

fn base_url(override_url: Option<&str>, debug: bool) -> Result<Url> {
    if !debug || override_url.is_none() {
        return Url::parse(BASE_URL).map_err(|_| AiError::bad());
    }
    let url = Url::parse(override_url.unwrap_or_default())
        .map_err(|_| AiError::new("CONFIG_ERROR", "AI 模拟服务地址无效，只允许本机 HTTP 端口"))?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AiError::new(
            "CONFIG_ERROR",
            "AI 模拟服务地址无效，只允许本机 HTTP 端口",
        ));
    }
    Ok(url)
}

fn configured_url() -> Result<Url> {
    #[cfg(debug_assertions)]
    {
        base_url(std::env::var("WORKBENCH_AI_BASE_URL").ok().as_deref(), true)
    }
    #[cfg(not(debug_assertions))]
    {
        base_url(None, false)
    }
}

fn client(url: &Url, timeout: Duration) -> Result<Client> {
    let mut builder = Client::builder()
        .tls_backend_rustls()
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never());
    if url.scheme() == "http" {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|_| AiError::new("NETWORK", "网络客户端初始化失败，请手动新建"))
}

fn http_error(status: u16) -> AiError {
    match status {
        401 => AiError::new("KEY_INVALID", "API key 无效，请到设置中检查"),
        402 => AiError::new(
            "INSUFFICIENT_BALANCE",
            "DeepSeek 账户余额不足，请到开放平台充值或手动新建",
        ),
        429 => AiError::new("RATE_LIMITED", "请求太频繁，请稍后再试"),
        500..=599 => AiError::new("UPSTREAM", "DeepSeek 服务暂时不可用，请手动新建"),
        _ => AiError::bad(),
    }
}

fn network_error(error: reqwest::Error) -> AiError {
    // reqwest 的原始错误可能带 URL/正文，不向前端转发或记录它。
    if error.is_timeout() {
        AiError::new("TIMEOUT", "DeepSeek 响应超时，请手动新建")
    } else {
        AiError::new("NETWORK", "网络连接失败，请手动新建")
    }
}

async fn send(client: &Client, request: reqwest::Request) -> Result<(u16, Vec<u8>)> {
    let mut response = client.execute(request).await.map_err(network_error)?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Ok((status, vec![]));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE {
            return Err(AiError::bad());
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, body))
}

fn build_request(
    client: &Client,
    method: Method,
    url: Url,
    key: &ApiKey,
    body: Option<Vec<u8>>,
) -> Result<reqwest::Request> {
    let mut authorization =
        header::HeaderValue::from_str(&format!("Bearer {}", key.0)).map_err(|_| AiError::bad())?;
    authorization.set_sensitive(true);
    let mut builder = client
        .request(method, url)
        .header(header::AUTHORIZATION, authorization);
    if let Some(body) = body {
        builder = builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(body);
    }
    builder.build().map_err(|_| AiError::bad())
}

#[derive(Serialize)]
pub struct ConnectionStatus {
    ok: bool,
}

#[tauri::command]
pub async fn ai_key_test(
    window: WebviewWindow,
    state: tauri::State<'_, AiState>,
) -> Result<ConnectionStatus> {
    main_only(window.label())?;
    let _flight = state.acquire()?;
    let key = read_key(window.app_handle())?
        .ok_or_else(|| AiError::new("KEY_MISSING", "请先在设置中填写 DeepSeek API key"))?;
    let base = configured_url()?;
    let client = client(&base, Duration::from_secs(30))?;
    let request = build_request(
        &client,
        Method::GET,
        base.join("models").map_err(|_| AiError::bad())?,
        &key,
        None,
    )?;
    let started = Instant::now();
    let result = send(&client, request).await;
    if let Ok(path) = data_directory(window.app_handle()) {
        audit(
            &path,
            &format!(
                "test status={} elapsed_ms={}",
                result.as_ref().map(|r| r.0).unwrap_or(0),
                started.elapsed().as_millis()
            ),
        );
    }
    let (status, body) = result?;
    if !(200..300).contains(&status) {
        return Err(http_error(status));
    }
    let models: Value = serde_json::from_slice(&body).map_err(|_| AiError::bad())?;
    if models.get("object").and_then(Value::as_str) != Some("list")
        || !models.get("data").is_some_and(Value::is_array)
    {
        return Err(AiError::bad());
    }
    Ok(ConnectionStatus { ok: true })
}

fn finish_response(
    result: Result<ChatResponse>,
    persist_tokens: impl FnOnce(&protocol::TokenUsage) -> Result<()>,
    audit_failure: impl FnOnce(&AiError),
) -> Result<ChatResponse> {
    if let Ok(reply) = &result {
        if let Err(error) = persist_tokens(&reply.usage) {
            // 回复已经成功，附加统计写盘失败只审计，不丢弃回复或要求用户重发。
            audit_failure(&error);
        }
    }
    result
}

#[tauri::command]
pub async fn ai_chat(
    window: WebviewWindow,
    state: tauri::State<'_, AiState>,
    request: Value,
) -> Result<ChatResponse> {
    main_only(window.label())?;
    let _flight = state.acquire()?;
    let (model, body) = request_body(request)?;
    let key = read_key(window.app_handle())?
        .ok_or_else(|| AiError::new("KEY_MISSING", "请先在设置中填写 DeepSeek API key"))?;
    let base = configured_url()?;
    let client = client(&base, Duration::from_secs(30))?;
    let request = build_request(
        &client,
        Method::POST,
        base.join("chat/completions").map_err(|_| AiError::bad())?,
        &key,
        Some(body),
    )?;
    state.with_usage(window.app_handle(), |store| store.charge(now()))?;
    let started = Instant::now();
    let response = send(&client, request).await;
    let status = response.as_ref().map(|r| r.0).unwrap_or(0);
    let result = response.and_then(|(status, body)| {
        if (200..300).contains(&status) {
            normalize_response(&body)
        } else {
            Err(http_error(status))
        }
    });
    let tokens = result
        .as_ref()
        .ok()
        .map(|r| (r.usage.prompt_tokens, r.usage.completion_tokens))
        .unwrap_or_default();
    if let Ok(path) = data_directory(window.app_handle()) {
        audit(
            &path,
            &format!(
                "chat model={model} status={status} elapsed_ms={} prompt_tokens={} completion_tokens={} code={}",
                started.elapsed().as_millis(),
                tokens.0,
                tokens.1,
                result.as_ref().err().map(|e| e.code).unwrap_or("OK")
            ),
        );
    }
    finish_response(
        result,
        |usage| {
            state.with_usage(window.app_handle(), |store| {
                store.add_tokens(usage.prompt_tokens, usage.completion_tokens, now())
            })
        },
        |error| {
            if let Ok(path) = data_directory(window.app_handle()) {
                audit(
                    &path,
                    &format!("token_usage_save_failed code={}", error.code),
                );
            }
        },
    )
}
