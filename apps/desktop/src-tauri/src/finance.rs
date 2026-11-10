use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdout, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
    child: Option<Child>,
    control: Arc<RunControl>,
    updating: bool,
    exit_code: Option<i32>,
}

struct RunControl {
    scratch: PathBuf,
    stop_at: Mutex<Option<Instant>>,
}

impl RunControl {
    fn new(parent: &Path) -> std::io::Result<Self> {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        std::fs::create_dir_all(parent)?;
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let scratch = parent.join(format!(
            "{}-{time}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&scratch)?;
        Ok(Self {
            scratch,
            stop_at: Mutex::new(None),
        })
    }

    fn cancel_file(&self) -> PathBuf {
        self.scratch.join("cancel")
    }

    fn requested_at(&self) -> Option<Instant> {
        *self
            .stop_at
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn request_stop(&self) -> std::io::Result<()> {
        let mut stop_at = self
            .stop_at
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if stop_at.is_some() {
            return Ok(());
        }
        *stop_at = Some(Instant::now());
        std::fs::write(self.cancel_file(), [])
    }
}

impl Drop for RunControl {
    fn drop(&mut self) {
        // 只清理由本次运行创建的专属目录，其他进程的 _MEI 目录不在此范围内。
        let _ = std::fs::remove_dir_all(&self.scratch);
    }
}

const VERIFY_TIMEOUT: Duration = Duration::from_secs(60);
const CANCEL_GRACE: Duration = Duration::from_secs(5);

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

const CACHE_POOL_KEY: &str = "sqlite:finance-read-only";

#[derive(Serialize)]
pub struct CacheConnection {
    key: &'static str,
    bytes: u64,
}

async fn open_cache(path: &Path) -> std::result::Result<sqlx::SqlitePool, sqlx::Error> {
    sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(path)
                .read_only(true),
        )
        .await
}

#[tauri::command]
pub async fn finance_reader_open(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<Option<CacheConnection>> {
    main_only(&window)?;
    let path = database_path(&app)?;
    let bytes = match std::fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(FinanceError::new("DB_ERROR", "无法读取金融数据文件")),
    };
    let pools = app.state::<tauri_plugin_sql::DbInstances>();
    let mut instances = pools.0.write().await;
    if !instances.contains_key(CACHE_POOL_KEY) {
        let pool = open_cache(&path).await.map_err(|_| {
            FinanceError::new("DB_ERROR", "无法只读打开金融缓存，请检查文件或重建金融数据")
        })?;
        instances.insert(
            CACHE_POOL_KEY.into(),
            tauri_plugin_sql::DbPool::Sqlite(pool),
        );
    }
    Ok(Some(CacheConnection {
        key: CACHE_POOL_KEY,
        bytes,
    }))
}

#[tauri::command]
pub async fn finance_reader_close(window: WebviewWindow, app: AppHandle) -> Result<()> {
    main_only(&window)?;
    let pools = app.state::<tauri_plugin_sql::DbInstances>();
    let pool = pools.0.write().await.remove(CACHE_POOL_KEY);
    if let Some(tauri_plugin_sql::DbPool::Sqlite(pool)) = pool {
        pool.close().await;
    }
    Ok(())
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

fn command(app: &AppHandle, mode: Option<UpdateMode>, control: &RunControl) -> Result<Command> {
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
        .stderr(Stdio::piped())
        .arg("--cancel-file")
        .arg(control.cancel_file())
        .env("TEMP", &control.scratch)
        .env("TMP", &control.scratch)
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

struct ChildPipes {
    stdout: ChildStdout,
    stderr: ChildStderr,
    token: String,
}

fn start(
    app: &AppHandle,
    state: &FinanceState,
    mode: Option<UpdateMode>,
    fallback: bool,
) -> Result<Option<ChildPipes>> {
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
    let scratch_parent = app
        .path()
        .app_cache_dir()
        .map_err(|_| FinanceError::new("ENGINE_START_FAILED", "无法定位金融引擎临时目录"))?
        .join("finance-runs");
    let control = Arc::new(
        RunControl::new(&scratch_parent)
            .map_err(|_| FinanceError::new("ENGINE_START_FAILED", "无法创建金融引擎临时目录"))?,
    );
    let mut child = command(app, mode, &control)?
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
    let stderr = child.stderr.take().expect("金融引擎 stderr 已配置为管道");
    *active = Some(Active {
        child: Some(child),
        control,
        updating: mode.is_some(),
        exit_code: None,
    });
    Ok(Some(ChildPipes {
        stdout,
        stderr,
        token,
    }))
}

fn read_stdout(
    app: &AppHandle,
    stdout: ChildStdout,
    token: &str,
    updating: bool,
) -> (bool, Option<FinanceError>) {
    let mut failure = None;
    let mut verified = false;
    for line in BufReader::new(stdout)
        .lines()
        .map_while(std::result::Result::ok)
    {
        let line = line.replace(token, "[已隐藏]");
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
    (verified, failure)
}

fn redact_stderr(
    mut input: impl BufRead,
    mut output: impl Write,
    token: &str,
) -> std::io::Result<()> {
    let mut line = Vec::new();
    while input.read_until(b'\n', &mut line)? > 0 {
        let safe = String::from_utf8_lossy(&line).replace(token, "[已隐藏]");
        output.write_all(safe.as_bytes())?;
        line.clear();
    }
    Ok(())
}

fn append_stderr(app: &AppHandle, stderr: ChildStderr, token: &str) {
    let file = app.path().app_log_dir().ok().and_then(|folder| {
        std::fs::create_dir_all(&folder).ok()?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(folder.join("finance-engine.log"))
            .ok()
    });
    let mut reader = BufReader::new(stderr);
    if let Some(file) = file {
        let _ = redact_stderr(&mut reader, file, token);
    }
    let _ = std::io::copy(&mut reader, &mut std::io::sink());
}

fn wait_for_child(
    child: &mut Child,
    control: &RunControl,
    timeout: Option<Duration>,
    grace: Duration,
) -> (Option<i32>, bool) {
    let started = Instant::now();
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return (status.code(), timed_out),
            Ok(None) => {}
            Err(_) => break,
        }
        if !timed_out && timeout.is_some_and(|limit| started.elapsed() >= limit) {
            timed_out = true;
            let _ = control.request_stop();
        }
        if control
            .requested_at()
            .is_some_and(|instant| instant.elapsed() >= grace)
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = kill_tree(child);
    (
        child.wait().ok().and_then(|status| status.code()),
        timed_out,
    )
}

fn collect(app: AppHandle, state: FinanceState, pipes: ChildPipes, updating: bool) -> Result<()> {
    let (mut child, control) = {
        let mut active = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = active.as_mut().expect("金融进程运行时占用槽位");
        (
            entry.child.take().expect("仅收集一次金融进程"),
            Arc::clone(&entry.control),
        )
    };
    // 槽位保持占用，但等待不持有全局锁，取消和退出仍能写停止信号。
    let ChildPipes {
        stdout,
        stderr,
        token,
    } = pipes;
    let (code, timed_out, verified, failure) = std::thread::scope(|scope| {
        let out = scope.spawn(|| read_stdout(&app, stdout, &token, updating));
        let err = scope.spawn(|| append_stderr(&app, stderr, &token));
        let (code, timed_out) = wait_for_child(
            &mut child,
            &control,
            (!updating).then_some(VERIFY_TIMEOUT),
            CANCEL_GRACE,
        );
        let (verified, failure) = out.join().unwrap_or_default();
        let _ = err.join();
        (code, timed_out, verified, failure)
    });
    let mut active = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let exit_code = active.take().and_then(|entry| entry.exit_code);
    let cancelled = control.requested_at().is_some();
    drop(control);
    if updating {
        let _ = app.emit_to(
            "main",
            EVENT,
            json!({"type": "engine_exit", "code": code, "cancelled": cancelled}).to_string(),
        );
    }
    drop(active);
    if let Some(code) = exit_code {
        app.exit(code);
    }
    if timed_out {
        return Err(FinanceError::new(
            "VERIFY_TIMEOUT",
            "测试连接超时（约 60 秒），请检查网络后重试",
        ));
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
    let Some(pipes) = start(&app, &state, Some(mode), akshare_fallback.unwrap_or(true))? else {
        return Ok("already_running");
    };
    std::thread::spawn(move || {
        let _ = collect(app, state, pipes, true);
    });
    Ok("started")
}

fn stop(app: &AppHandle) -> Result<()> {
    let state = app.state::<FinanceState>();
    let active = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(entry) = active.as_ref() {
        entry.control.request_stop().map_err(|_| {
            FinanceError::new(
                "ENGINE_CANCEL_FAILED",
                "无法写入停止信号，将尝试强制结束金融引擎",
            )
        })?;
    }
    Ok(())
}

pub fn defer_exit(app: &AppHandle, code: i32) -> bool {
    let state = app.state::<FinanceState>();
    let mut active = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(entry) = active.as_mut() {
        entry.exit_code = Some(code);
        let _ = entry.control.request_stop();
        return true;
    }
    false
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
        let Some(pipes) = start(&app, &state, None, false)? else {
            return Err(FinanceError::new(
                "ENGINE_BUSY",
                "金融引擎正在运行，请稍后测试连接",
            ));
        };
        collect(app, state, pipes, false)
    })
    .await
    .map_err(|_| FinanceError::new("ENGINE_EXIT", "测试连接未完成"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_redacts_every_occurrence_before_writing() {
        let mut log = Vec::new();
        redact_stderr(
            &b"token=private-test\r\nreceived private-test"[..],
            &mut log,
            "private-test",
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(log).unwrap(),
            "token=[已隐藏]\r\nreceived [已隐藏]"
        );
    }

    #[test]
    fn fixed_cache_connection_is_read_only_and_does_not_create_files() {
        let control =
            RunControl::new(&std::env::temp_dir().join("workbench-finance-tests")).unwrap();
        let path = control.scratch.join("finance # test.db");
        tauri::async_runtime::block_on(async {
            assert!(open_cache(&path).await.is_err());
            assert!(!path.exists());
            let writer = sqlx::sqlite::SqlitePoolOptions::new()
                .connect_with(
                    sqlx::sqlite::SqliteConnectOptions::new()
                        .filename(&path)
                        .create_if_missing(true),
                )
                .await
                .unwrap();
            sqlx::query("CREATE TABLE marker (value INTEGER)")
                .execute(&writer)
                .await
                .unwrap();
            sqlx::query("INSERT INTO marker VALUES (42)")
                .execute(&writer)
                .await
                .unwrap();
            writer.close().await;
            let reader = open_cache(&path).await.unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT value FROM marker")
                    .fetch_one(&reader)
                    .await
                    .unwrap(),
                42
            );
            assert!(
                sqlx::query("DELETE FROM marker")
                    .execute(&reader)
                    .await
                    .is_err()
            );
            reader.close().await;
        });
    }

    #[cfg(windows)]
    #[test]
    fn verify_deadline_requests_graceful_stop_and_removes_owned_scratch() {
        let control =
            RunControl::new(&std::env::temp_dir().join("workbench-finance-tests")).unwrap();
        let scratch = control.scratch.clone();
        let mut command = Command::new("powershell.exe");
        hide_console(&mut command);
        let mut child = command.args(["-NoProfile", "-NonInteractive", "-Command",
            "while (!(Test-Path -LiteralPath $env:WORKBENCH_TEST_CANCEL)) { Start-Sleep -Milliseconds 20 }; exit 0"])
            .env("WORKBENCH_TEST_CANCEL", control.cancel_file())
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let (code, timed_out) = wait_for_child(
            &mut child,
            &control,
            Some(Duration::from_millis(80)),
            CANCEL_GRACE,
        );
        assert!(timed_out);
        assert_eq!(code, Some(0));
        assert!(control.cancel_file().exists());
        drop(control);
        assert!(!scratch.exists());
    }

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
