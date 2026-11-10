use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_shell::ShellExt;

const SERVICE: &str = "com.royce.workbench.finance";
const EVENT: &str = "finance://event";

#[derive(Serialize)]
pub struct FinanceError {
    code: String,
    message: String,
}

impl FinanceError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

type Result<T> = std::result::Result<T, FinanceError>;

struct Active {
    child: Child,
    cancelled: bool,
    updating: bool,
}

#[derive(Clone, Default)]
pub struct FinanceState(Arc<Mutex<Option<Active>>>);

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateMode {
    Auto,
    FullRebuild,
}

impl UpdateMode {
    fn as_arg(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::FullRebuild => "full-rebuild",
        }
    }
}

fn main_only(window: &WebviewWindow) -> Result<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(FinanceError::new("FORBIDDEN", "只有主窗口可以访问金融服务"))
    }
}

fn credential() -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, "tushare").map_err(|_| credential_error())
}

fn credential_error() -> FinanceError {
    FinanceError::new(
        "CREDENTIAL_ERROR",
        "无法访问系统凭据，请检查 Windows 凭据管理器",
    )
}

fn stored_token() -> Result<Option<String>> {
    match credential()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(credential_error()),
    }
}

#[derive(Serialize)]
pub struct TokenStatus {
    configured: bool,
    tail: Option<String>,
}

fn token_status(token: Option<&str>) -> TokenStatus {
    TokenStatus {
        configured: token.is_some(),
        tail: token.and_then(|value| {
            let mut chars = value.chars().rev();
            let tail: Vec<char> = chars.by_ref().take(4).collect();
            chars.next().map(|_| tail.into_iter().rev().collect())
        }),
    }
}

#[tauri::command]
pub fn finance_token_set(window: WebviewWindow, token: String) -> Result<TokenStatus> {
    main_only(&window)?;
    let token = token.trim();
    if token.len() < 5
        || token.len() > 1024
        || !token.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(FinanceError::new(
            "TOKEN_INVALID",
            "请输入有效格式的 Tushare token",
        ));
    }
    credential()?
        .set_password(token)
        .map_err(|_| credential_error())?;
    Ok(token_status(Some(token)))
}

#[tauri::command]
pub fn finance_token_status(window: WebviewWindow) -> Result<TokenStatus> {
    main_only(&window)?;
    Ok(token_status(stored_token()?.as_deref()))
}

#[tauri::command]
pub fn finance_token_clear(window: WebviewWindow) -> Result<()> {
    main_only(&window)?;
    match credential()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(credential_error()),
    }
}

fn database_path(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("finance.db"))
        .map_err(|_| FinanceError::new("DB_ERROR", "无法定位金融数据文件夹"))
}

#[tauri::command]
pub fn finance_db_path(window: WebviewWindow, app: AppHandle) -> Result<String> {
    main_only(&window)?;
    Ok(database_path(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn finance_db_size(window: WebviewWindow, app: AppHandle) -> Result<Option<u64>> {
    main_only(&window)?;
    match std::fs::metadata(database_path(&app)?) {
        Ok(metadata) => Ok(Some(metadata.len())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(FinanceError::new("DB_ERROR", "无法读取金融数据文件")),
    }
}

#[tauri::command]
pub fn finance_open_directory(window: WebviewWindow, app: AppHandle) -> Result<()> {
    main_only(&window)?;
    let path = database_path(&app)?;
    let folder = path
        .parent()
        .ok_or_else(|| FinanceError::new("DB_ERROR", "无法定位金融数据文件夹"))?;
    std::fs::create_dir_all(folder)
        .map_err(|_| FinanceError::new("DB_ERROR", "无法创建金融数据文件夹"))?;
    #[allow(deprecated)]
    app.shell()
        .open(folder.to_string_lossy(), None)
        .map_err(|_| FinanceError::new("DB_ERROR", "无法打开金融数据文件夹"))
}

fn add_arguments(command: &mut Command, path: &Path, mode: Option<UpdateMode>) {
    command
        .arg(if mode.is_some() { "update" } else { "verify" })
        .arg("--db")
        .arg(path);
    if let Some(mode) = mode {
        command.args(["--mode", mode.as_arg()]);
    }
}

fn engine_missing(app: &AppHandle) -> FinanceError {
    let folder = app
        .path()
        .app_log_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    FinanceError::new(
        "ENGINE_MISSING",
        &format!("无法启动金融引擎，请重新安装 WorkBench。日志目录：{folder}"),
    )
}

fn command(app: &AppHandle, mode: Option<UpdateMode>) -> Result<Command> {
    let mut command = if cfg!(debug_assertions)
        && std::env::var("WORKBENCH_FINANCE_ENGINE_DEV").as_deref() == Ok("1")
    {
        let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../engines/finance");
        let mut command = Command::new("uv");
        command
            .args(["run", "--locked", "--project"])
            .arg(project)
            .args(["python", "-m", "finance_engine"]);
        command
    } else {
        // 插件负责定位安装的 sidecar。标准进程接口允许写完后关闭 stdin。
        app.shell()
            .sidecar("finance-engine")
            .map_err(|_| engine_missing(app))?
            .into()
    };
    add_arguments(&mut command, &database_path(app)?, mode);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_remove("TUSHARE_TOKEN");
    hide_console(&mut command);
    Ok(command)
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn kill_tree(child: &mut Child) -> std::io::Result<()> {
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        // PyInstaller 单文件和 uv 均会再起进程，取消时结束整棵进程树。
        let mut command = Command::new(PathBuf::from(root).join("System32/taskkill.exe"));
        hide_console(&mut command);
        if command
            .args(["/T", "/F", "/PID"])
            .arg(child.id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
        {
            return Ok(());
        }
    }
    child.kill()
}

fn start(
    app: &AppHandle,
    state: &FinanceState,
    mode: Option<UpdateMode>,
    fallback: bool,
) -> Result<Option<(ChildStdout, String)>> {
    let mut active = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(entry) = active.as_ref() {
        if mode.is_some() && !entry.updating {
            return Err(FinanceError::new(
                "ENGINE_BUSY",
                "正在测试 Tushare 连接，请稍后更新",
            ));
        }
        return Ok(None);
    }
    let token = stored_token()?
        .ok_or_else(|| FinanceError::new("TOKEN_MISSING", "请先在设置中保存 Tushare token"))?;
    let input = format!(
        "{}\n",
        json!({"tushare_token": token, "akshare_fallback": fallback})
    );
    let mut child = command(app, mode)?
        .spawn()
        .map_err(|_| engine_missing(app))?;
    let sent = child
        .stdin
        .take()
        .is_some_and(|mut stdin| stdin.write_all(input.as_bytes()).is_ok());
    if !sent {
        let _ = kill_tree(&mut child);
        let _ = child.wait();
        return Err(FinanceError::new(
            "ENGINE_START_FAILED",
            "无法向金融引擎提供连接凭据",
        ));
    }
    let stdout = child.stdout.take().expect("金融引擎 stdout 已配置为管道");
    *active = Some(Active {
        child,
        cancelled: false,
        updating: mode.is_some(),
    });
    Ok(Some((stdout, token)))
}

fn collect(
    app: AppHandle,
    state: FinanceState,
    stdout: ChildStdout,
    token: String,
    updating: bool,
) -> Result<()> {
    let mut failure = None;
    let mut verified = false;
    for line in BufReader::new(stdout)
        .lines()
        .map_while(std::result::Result::ok)
    {
        let line = line.replace(&token, "[已隐藏]");
        if updating {
            let _ = app.emit_to("main", EVENT, &line);
        } else if let Ok(event) = serde_json::from_str::<Value>(&line) {
            if event["type"] == "error" {
                failure = Some(FinanceError::new(
                    event["code"].as_str().unwrap_or("INTERNAL"),
                    event["message"].as_str().unwrap_or("测试连接失败"),
                ));
            }
            if event["type"] == "done" && event["status"] == "ok" {
                verified = true;
            }
        }
    }
    let (code, cancelled) = {
        let mut active = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut entry = active.take().expect("金融进程运行时占用槽位");
        (
            entry.child.wait().ok().and_then(|status| status.code()),
            entry.cancelled,
        )
    };
    if updating {
        let _ = app.emit_to(
            "main",
            EVENT,
            json!({"type": "engine_exit", "code": code, "cancelled": cancelled}).to_string(),
        );
    }
    if code == Some(0) && (updating || verified) {
        return Ok(());
    }
    Err(failure.unwrap_or_else(|| FinanceError::new("ENGINE_EXIT", "金融引擎未正常完成")))
}

#[tauri::command]
pub fn finance_update_start(
    window: WebviewWindow,
    app: AppHandle,
    mode: UpdateMode,
    akshare_fallback: Option<bool>,
) -> Result<&'static str> {
    main_only(&window)?;
    let state = app.state::<FinanceState>().inner().clone();
    let Some((stdout, token)) = start(&app, &state, Some(mode), akshare_fallback.unwrap_or(true))?
    else {
        return Ok("already_running");
    };
    std::thread::spawn(move || {
        let _ = collect(app, state, stdout, token, true);
    });
    Ok("started")
}

pub fn stop(app: &AppHandle) -> Result<()> {
    let state = app.state::<FinanceState>();
    let mut active = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(entry) = active.as_mut() {
        kill_tree(&mut entry.child)
            .map_err(|_| FinanceError::new("ENGINE_CANCEL_FAILED", "未能停止金融引擎"))?;
        entry.cancelled = true;
    }
    Ok(())
}

#[tauri::command]
pub fn finance_update_cancel(window: WebviewWindow, app: AppHandle) -> Result<()> {
    main_only(&window)?;
    stop(&app)
}

#[tauri::command]
pub async fn finance_verify(window: WebviewWindow, app: AppHandle) -> Result<()> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<FinanceState>().inner().clone();
        let Some((stdout, token)) = start(&app, &state, None, false)? else {
            return Err(FinanceError::new(
                "ENGINE_BUSY",
                "金融引擎正在运行，请稍后测试连接",
            ));
        };
        collect(app, state, stdout, token, false)
    })
    .await
    .map_err(|_| FinanceError::new("ENGINE_EXIT", "测试连接未完成"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_arguments_do_not_contain_token() {
        let token = "dummy-private-token";
        let path = Path::new("C:/Users/Test/AppData/Local/com.royce.workbench/finance.db");
        for mode in [None, Some(UpdateMode::Auto), Some(UpdateMode::FullRebuild)] {
            let mut command = Command::new("finance-engine");
            add_arguments(&mut command, path, mode);
            let args: Vec<_> = command.get_args().collect();
            assert!(
                args.iter()
                    .all(|arg| !arg.to_string_lossy().contains(token))
            );
            assert_eq!(args.len(), if mode.is_some() { 5 } else { 3 });
        }
        let status = token_status(Some(token));
        assert_eq!(status.tail.as_deref(), Some("oken"));
    }
}
