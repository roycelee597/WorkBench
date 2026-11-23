use crate::{
    module_engine::{EngineError as FinanceError, read_event},
    module_runtime::{FINANCE_ID, ModuleState, only_main},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;

const EVENT: &str = "finance://event";
pub(crate) const ENGINE_LOG: &str = "finance-engine.log";
const ENGINE_LOG_LIMIT: usize = 1024 * 1024;
pub(crate) const VERIFY_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const CANCEL_GRACE: Duration = Duration::from_secs(5);

type Result<T> = std::result::Result<T, FinanceError>;

pub(crate) struct RunControl {
    scratch: PathBuf,
    log_dir: Option<PathBuf>,
    stop_at: Mutex<Option<Instant>>,
}

impl RunControl {
    pub(crate) fn new(parent: &Path, log_dir: Option<PathBuf>) -> io::Result<Self> {
        fs::create_dir_all(parent)?;
        let scratch = parent.join(Uuid::new_v4().simple().to_string());
        fs::create_dir(&scratch)?;
        Ok(Self {
            scratch,
            log_dir,
            stop_at: Mutex::new(None),
        })
    }

    pub(crate) fn cancel_file(&self) -> PathBuf {
        self.scratch.join("cancel")
    }

    pub(crate) fn requested_at(&self) -> Option<Instant> {
        *self
            .stop_at
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn request_stop(&self) -> io::Result<()> {
        let mut stop_at = self
            .stop_at
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if stop_at.is_some() {
            return Ok(());
        }
        // 写信号失败时仍设置截止时间，Job 层会在宽限期后终止进程树。
        *stop_at = Some(Instant::now());
        fs::write(self.cancel_file(), [])
    }

    pub(crate) fn cleanup(&self) {
        if let Err(error) = fs::remove_dir_all(&self.scratch)
            && error.kind() != io::ErrorKind::NotFound
        {
            let warning = format!(
                "[WARN] 无法清理金融引擎临时目录 {}：{error}\n",
                self.scratch.display()
            );
            if !self
                .log_dir
                .as_ref()
                .is_some_and(|dir| append_engine_log(dir, &warning, ENGINE_LOG_LIMIT).is_ok())
            {
                let _ = io::stderr().lock().write_all(warning.as_bytes());
            }
        }
    }
}

impl Drop for RunControl {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum UpdateMode {
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

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum EngineInput {
    Update {
        mode: UpdateMode,
        #[serde(rename = "akshareFallback", default = "default_fallback")]
        akshare_fallback: bool,
    },
    Verify {},
}

fn default_fallback() -> bool {
    true
}

impl EngineInput {
    pub(crate) fn updating(&self) -> bool {
        matches!(self, Self::Update { .. })
    }
}

pub(crate) struct FinanceRun {
    pub(crate) control: std::sync::Arc<RunControl>,
    pub(crate) token: String,
    pub(crate) updating: bool,
    pub(crate) arguments: Vec<OsString>,
    akshare_fallback: bool,
}

fn engine_arguments(path: &Path, request: &EngineInput) -> Vec<OsString> {
    let mut args = vec![
        if request.updating() {
            "update"
        } else {
            "verify"
        }
        .into(),
        "--db".into(),
        path.as_os_str().to_owned(),
    ];
    if let EngineInput::Update { mode, .. } = request {
        args.extend(["--mode".into(), mode.as_arg().into()]);
    }
    args
}

impl FinanceRun {
    // 在通用引擎持有模块锁时调用，防止启动与卸载竞争。
    pub(crate) fn prepare(app: &AppHandle, request: &EngineInput) -> Result<Self> {
        let token = stored_token(app)?
            .ok_or_else(|| FinanceError::new("TOKEN_MISSING", "请先在设置中保存 Tushare token"))?;
        let scratch_parent = app
            .path()
            .app_cache_dir()
            .map_err(|_| FinanceError::new("ENGINE_START_FAILED", "无法定位金融引擎临时目录"))?
            .join("finance-runs");
        let control = std::sync::Arc::new(
            RunControl::new(&scratch_parent, app.path().app_log_dir().ok()).map_err(|_| {
                FinanceError::new("ENGINE_START_FAILED", "无法创建金融引擎临时目录")
            })?,
        );
        let mut arguments = engine_arguments(&database_path(app)?, request);
        arguments.extend([
            "--cancel-file".into(),
            control.cancel_file().into_os_string(),
        ]);
        let fallback = matches!(
            request,
            EngineInput::Update {
                akshare_fallback: true,
                ..
            }
        );
        Ok(Self {
            control,
            akshare_fallback: fallback,
            token,
            updating: request.updating(),
            arguments,
        })
    }

    pub(crate) fn input(&self) -> Value {
        json!({ "tushare_token": self.token, "akshare_fallback": self.akshare_fallback })
    }

    pub(crate) fn environment(&self) -> [(&'static str, OsString); 2] {
        let path = self.control.scratch.as_os_str();
        [("TEMP", path.to_owned()), ("TMP", path.to_owned())]
    }

    pub(crate) fn append_stderr(&self, stderr: fs::File) {
        let mut reader = BufReader::new(stderr);
        if let Some(folder) = &self.control.log_dir {
            let _ = redact_stderr(&mut reader, &self.token, |line| {
                append_engine_log(folder, line, ENGINE_LOG_LIMIT)
            });
        }
        let _ = io::copy(&mut reader, &mut io::sink());
    }

    pub(crate) fn forward(&self, app: &AppHandle, event: &Value) {
        if self.updating {
            let _ = app.emit_to("main", EVENT, event.to_string());
        }
    }
}

fn require_installed(app: &AppHandle) -> Result<()> {
    with_installed(app, || Ok(()))
}

fn with_installed<T>(app: &AppHandle, action: impl FnOnce() -> Result<T>) -> Result<T> {
    app.state::<ModuleState>()
        .with_store(|store| {
            let module = store.active(FINANCE_ID)?;
            if module
                .grants
                .iter()
                .any(|permission| permission == "finance")
            {
                Ok(action())
            } else {
                Ok(Err(FinanceError::new(
                    "PERMISSION_DENIED",
                    "金融指标权限已撤销",
                )))
            }
        })
        .map_err(|_| FinanceError::new("MODULE_NOT_INSTALLED", "请先在模块管理中安装金融指标"))?
}

fn main_only(window: &WebviewWindow) -> Result<()> {
    only_main(window).map_err(|_| FinanceError::new("FORBIDDEN", "只有主窗口可以访问金融服务"))
}

fn credential(app: &AppHandle) -> Result<keyring::Entry> {
    // 隔离构建与正式版使用各自的凭据，正式版服务名仍为 com.royce.workbench.finance。
    let service = format!("{}.finance", app.config().identifier);
    keyring::Entry::new(&service, "tushare").map_err(|_| credential_error())
}

fn credential_error() -> FinanceError {
    FinanceError::new(
        "CREDENTIAL_ERROR",
        "无法访问系统凭据，请检查 Windows 凭据管理器",
    )
}

fn stored_token(app: &AppHandle) -> Result<Option<String>> {
    match credential(app)?.get_password() {
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
    with_installed(window.app_handle(), || {
        credential(window.app_handle())?
            .set_password(token)
            .map_err(|_| credential_error())?;
        Ok(token_status(Some(token)))
    })
}

#[tauri::command]
pub fn finance_token_status(window: WebviewWindow) -> Result<TokenStatus> {
    main_only(&window)?;
    with_installed(window.app_handle(), || {
        Ok(token_status(stored_token(window.app_handle())?.as_deref()))
    })
}

#[tauri::command]
pub fn finance_token_clear(window: WebviewWindow) -> Result<()> {
    main_only(&window)?;
    with_installed(window.app_handle(), || {
        match credential(window.app_handle())?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(credential_error()),
        }
    })
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
    let pools = app.state::<tauri_plugin_sql::DbInstances>();
    let mut instances = pools.0.write().await;
    // 卸载先停用模块，再用同一池锁关闭缓存。异步打开后再次确认安装状态。
    require_installed(&app)?;
    let path = database_path(&app)?;
    let bytes = match std::fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(FinanceError::new("DB_ERROR", "无法读取金融数据文件")),
    };
    if !instances.contains_key(CACHE_POOL_KEY) {
        let pool = open_cache(&path).await.map_err(|_| {
            FinanceError::new("DB_ERROR", "无法只读打开金融缓存，请检查文件或重建金融数据")
        })?;
        if let Err(error) = require_installed(&app) {
            pool.close().await;
            return Err(error);
        }
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
    close_reader(&app).await;
    Ok(())
}

pub(crate) async fn close_reader(app: &AppHandle) {
    let pools = app.state::<tauri_plugin_sql::DbInstances>();
    let mut instances = pools.0.write().await;
    if let Some(tauri_plugin_sql::DbPool::Sqlite(pool)) = instances.remove(CACHE_POOL_KEY) {
        pool.close().await;
    }
}

#[tauri::command]
pub fn finance_db_path(window: WebviewWindow, app: AppHandle) -> Result<String> {
    main_only(&window)?;
    require_installed(&app)?;
    Ok(database_path(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn finance_db_size(window: WebviewWindow, app: AppHandle) -> Result<Option<u64>> {
    main_only(&window)?;
    require_installed(&app)?;
    match std::fs::metadata(database_path(&app)?) {
        Ok(metadata) => Ok(Some(metadata.len())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(FinanceError::new("DB_ERROR", "无法读取金融数据文件")),
    }
}

#[tauri::command]
pub fn finance_open_directory(window: WebviewWindow, app: AppHandle) -> Result<()> {
    main_only(&window)?;
    require_installed(&app)?;
    let path = database_path(&app)?;
    let folder = path
        .parent()
        .ok_or_else(|| FinanceError::new("DB_ERROR", "无法定位金融数据文件夹"))?;
    with_installed(&app, || {
        fs::create_dir_all(folder)
            .map_err(|_| FinanceError::new("DB_ERROR", "无法创建金融数据文件夹"))
    })?;
    #[allow(deprecated)]
    app.shell()
        .open(folder.to_string_lossy(), None)
        .map_err(|_| FinanceError::new("DB_ERROR", "无法打开金融数据文件夹"))
}

fn redact_stderr(
    mut input: impl BufRead,
    token: &str,
    mut write_line: impl FnMut(&str) -> io::Result<()>,
) -> io::Result<()> {
    let mut line = Vec::new();
    while read_event(&mut input, &mut line)? {
        let safe = String::from_utf8_lossy(&line).replace(token, "[已隐藏]");
        write_line(&safe)?;
        line.clear();
    }
    Ok(())
}

fn append_engine_log(folder: &Path, line: &str, limit: usize) -> io::Result<()> {
    let shortened;
    let line = if line.len() > limit {
        let mut end = limit - 1;
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        shortened = format!("{}\n", &line[..end]);
        &shortened
    } else {
        line
    };

    let path = folder.join(ENGINE_LOG);
    match fs::metadata(&path) {
        Ok(metadata) if metadata.len().saturating_add(line.len() as u64) > limit as u64 => {
            // 在 Windows 上先关闭上一次写入的句柄，再替换旧的归档。
            fs::rename(&path, path.with_extension("log.1"))?;
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs::create_dir_all(folder)?,
        Err(error) => return Err(error),
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(line.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_redacts_every_occurrence_before_writing() {
        let mut log = Vec::new();
        redact_stderr(
            &b"token=private-test\r\nreceived private-test"[..],
            "private-test",
            |line| log.write_all(line.as_bytes()),
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(log).unwrap(),
            "token=[已隐藏]\r\nreceived [已隐藏]"
        );
    }

    #[test]
    fn log_rotation_keeps_only_latest_archive_and_redacts_before_writing() {
        let owner =
            RunControl::new(&std::env::temp_dir().join("workbench-finance-tests"), None).unwrap();
        let folder = &owner.scratch;
        let input = "first private-test\nsecond private-test\nthird private-test\n";
        redact_stderr(input.as_bytes(), "private-test", |line| {
            append_engine_log(folder, line, 32)
        })
        .unwrap();
        assert_eq!(
            fs::read_to_string(folder.join(ENGINE_LOG)).unwrap(),
            "third [已隐藏]\n"
        );
        assert_eq!(
            fs::read_to_string(folder.join("finance-engine.log.1")).unwrap(),
            "second [已隐藏]\n"
        );
        append_engine_log(folder, &"警告".repeat(30), 32).unwrap();
        let truncated = fs::read_to_string(folder.join(ENGINE_LOG)).unwrap();
        assert!(truncated.len() <= 32 && truncated.ends_with('\n'));
    }

    #[test]
    fn scratch_cleanup_failure_writes_a_warning() {
        let owner =
            RunControl::new(&std::env::temp_dir().join("workbench-finance-tests"), None).unwrap();
        let logs = owner.scratch.join("logs");
        let run = RunControl::new(&owner.scratch, Some(logs.clone())).unwrap();
        let scratch = run.scratch.clone();
        fs::remove_dir(&scratch).unwrap();
        fs::write(&scratch, "占位").unwrap();
        drop(run);
        let log = fs::read_to_string(logs.join(ENGINE_LOG)).unwrap();
        assert!(log.contains("[WARN] 无法清理金融引擎临时目录"));
        assert!(log.contains(scratch.to_str().unwrap()));
    }

    #[test]
    fn fixed_cache_connection_is_read_only_and_does_not_create_files() {
        let control =
            RunControl::new(&std::env::temp_dir().join("workbench-finance-tests"), None).unwrap();
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

    #[test]
    fn engine_arguments_do_not_contain_token() {
        let token = "dummy-private-token";
        let path = Path::new("fixture/finance.db");
        for (input, count) in [
            (EngineInput::Verify {}, 3),
            (
                EngineInput::Update {
                    mode: UpdateMode::Auto,
                    akshare_fallback: true,
                },
                5,
            ),
            (
                EngineInput::Update {
                    mode: UpdateMode::FullRebuild,
                    akshare_fallback: false,
                },
                5,
            ),
        ] {
            let args = engine_arguments(path, &input);
            assert!(
                args.iter()
                    .all(|arg| !arg.to_string_lossy().contains(token))
            );
            assert_eq!(args.len(), count);
        }
        let status = token_status(Some(token));
        assert_eq!(status.tail.as_deref(), Some("oken"));
    }

    #[test]
    fn accepts_only_fixed_finance_engine_operations() {
        assert!(serde_json::from_value::<EngineInput>(json!({"operation":"verify"})).is_ok());
        assert!(
            serde_json::from_value::<EngineInput>(json!({
                "operation":"update", "mode":"auto", "akshareFallback":false
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<EngineInput>(json!({
                "operation":"update", "mode":"auto", "tushare_token":"fake"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<EngineInput>(json!({
                "operation":"verify", "db":"elsewhere.db"
            }))
            .is_err()
        );
    }
}
