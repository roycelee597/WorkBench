#[cfg(windows)]
mod windows_job;

use crate::{
    finance::{self, EngineInput, FinanceRun, RunControl},
    module_runtime::{FINANCE_ID, ModuleState, local_path, only_main, pick_path, verify_engine},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use uuid::Uuid;

const MAX_LINE: usize = 64 * 1024;
// 金融完整回补的 done 行含 20 多条序列自 2005 年起的新日期摘要。
const MAX_FINANCE_LINE: usize = 4 * 1024 * 1024;
const MAX_TASKS: usize = 16;
const MAX_HANDLES: usize = 32;
const PATH_TTL: Duration = Duration::from_secs(300);
const MAX_MESSAGE: usize = 400;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct EngineError {
    code: String,
    message: String,
}

impl EngineError {
    pub(crate) fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn diagnostic(value: &Value) -> Self {
        let code = value["code"].as_str().filter(|code| {
            (1..=40).contains(&code.len())
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
        });
        if let Some(code) = code {
            let message = value["message"]
                .as_str()
                .map(|message| {
                    message
                        .chars()
                        .filter(|char| !char.is_control())
                        .take(MAX_MESSAGE)
                        .collect::<String>()
                })
                .filter(|message| !message.trim().is_empty());
            return Self::new(code, message.as_deref().unwrap_or("引擎报告错误"));
        }
        Self::new("ENGINE_ERROR", "引擎报告错误")
    }
}

impl From<String> for EngineError {
    fn from(message: String) -> Self {
        Self::new("ENGINE_ERROR", &message)
    }
}

impl From<&str> for EngineError {
    fn from(message: &str) -> Self {
        Self::new("ENGINE_ERROR", message)
    }
}

#[derive(Default)]
pub struct EngineState {
    modules: Mutex<HashMap<String, ModuleTasks>>,
    exiting: AtomicBool,
}

#[derive(Default)]
struct ModuleTasks {
    paths: HashMap<String, SelectedPath>,
    tasks: VecDeque<Task>,
    stopping: Option<Uuid>,
}

struct SelectedPath {
    path: PathBuf,
    expiry: Instant,
}

#[derive(Clone)]
struct Task {
    id: String,
    status: Arc<SharedStatus>,
    #[cfg(windows)]
    job: Arc<windows_job::Job>,
    finance: Option<Arc<RunControl>>,
    updating: bool,
}

#[derive(Default)]
struct SharedStatus {
    state: Mutex<TaskStatus>,
    changed: Condvar,
}

impl SharedStatus {
    fn wait(&self) -> Result<std::sync::MutexGuard<'_, TaskStatus>, String> {
        let state = self.state.lock().map_err(|_| "引擎任务状态不可用")?;
        self.changed
            .wait_while(state, |status| status.state == State::Running)
            .map_err(|_| "引擎任务状态不可用".into())
    }
}

#[derive(Default)]
struct TaskStatus {
    state: State,
    cancel_requested: bool,
    progress: Option<Value>,
    result: Option<Value>,
    error: Option<EngineError>,
    logs: VecDeque<&'static str>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum State {
    #[default]
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl TaskStatus {
    fn snapshot(&self) -> Value {
        let state = match self.state {
            State::Running => "running",
            State::Succeeded => "succeeded",
            State::Failed => "failed",
            State::Cancelled => "cancelled",
        };
        let mut value = json!({ "status": state });
        if let Some(progress) = &self.progress {
            value["progress"] = progress.clone();
        }
        if let Some(result) = &self.result {
            value["result"] = result.clone();
        }
        if let Some(error) = &self.error {
            value["error"] = json!(error);
        }
        value
    }

    fn log(&mut self, message: &'static str) {
        if self.logs.len() >= 128 {
            self.logs.pop_front();
        }
        self.logs.push_back(message);
    }

    fn event(&mut self, value: Value) {
        if self.state != State::Running {
            return;
        }
        // 日志只使用宿主固定文案；引擎诊断仅出现在结果和进度中。
        match value.get("type").and_then(Value::as_str) {
            Some("hello") => self.log("引擎已连接"),
            Some("stage") => self.log("进入下一阶段"),
            Some("warning") => self.log("引擎报告警告"),
            Some("progress") => {
                let current = match &value["current"] {
                    Value::String(current) if current.len() <= MAX_MESSAGE => json!(current),
                    Value::Number(current) => json!(current),
                    _ => Value::Null,
                };
                self.progress = Some(json!({
                    "done": value["done"].as_u64(),
                    "total": value["total"].as_u64(),
                    "current": current,
                }));
            }
            Some("done" | "result") => {
                if value["status"] == "failed" {
                    self.error
                        .get_or_insert_with(|| EngineError::new("ENGINE_EXIT", "引擎报告任务失败"));
                } else {
                    self.result = Some(value);
                }
            }
            Some("error") => {
                self.error = Some(EngineError::diagnostic(&value));
                self.log("引擎报告错误");
            }
            _ => {}
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartParams {
    input: Value,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    exec_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskParams {
    task_id: String,
}

fn selected_paths(
    tasks: &mut ModuleTasks,
    params: &StartParams,
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
    tasks
        .paths
        .retain(|_, selected| selected.expiry > Instant::now());
    let mut seen = HashSet::new();
    let mut resolve = |handles: &[String]| -> Result<Vec<PathBuf>, String> {
        handles
            .iter()
            .map(|handle| {
                if !seen.insert(handle.clone()) {
                    return Err("路径授权重复".into());
                }
                tasks
                    .paths
                    .get(handle)
                    .map(|entry| entry.path.clone())
                    .ok_or_else(|| "路径授权无效或过期，请重新选择".into())
            })
            .collect()
    };
    if params.paths.len() + params.exec_paths.len() > 16 {
        return Err("一次最多传入 16 个已授权路径".into());
    }
    Ok((resolve(&params.paths)?, resolve(&params.exec_paths)?))
}

#[tauri::command]
pub async fn module_dialog_open(
    window: WebviewWindow,
    id: String,
) -> Result<Option<Value>, String> {
    only_main(&window)?;
    let app = window.app_handle();
    let modules = app.state::<ModuleState>();
    modules.with_active(&id, "dialog.open", |_| Ok(()))?;
    let Some(path) = pick_path(app, false, None).await? else {
        return Ok(None);
    };
    if !local_path(&path) {
        return Err("请选择本机磁盘上的文件".into());
    }
    let path = path.canonicalize().map_err(|_| "无法读取所选文件")?;
    if !local_path(&path) {
        return Err("所选文件不能指向网络位置".into());
    }
    if !path.is_file() {
        return Err("请选择本地文件".into());
    }
    modules.with_active(&id, "dialog.open", |_| {
        let state = app.state::<EngineState>();
        let mut all = state.modules.lock().map_err(|_| "引擎状态不可用")?;
        let tasks = all.entry(id.clone()).or_default();
        tasks
            .paths
            .retain(|_, selected| selected.expiry > Instant::now());
        if tasks.paths.len() >= MAX_HANDLES {
            return Err("待使用的路径太多，请稍后重试".into());
        }
        let handle = Uuid::new_v4().to_string();
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        tasks.paths.insert(
            handle.clone(),
            SelectedPath {
                path,
                expiry: Instant::now() + PATH_TTL,
            },
        );
        Ok(Some(json!({ "handle": handle, "name": name })))
    })
}

pub(crate) fn read_event(reader: &mut impl BufRead, line: &mut Vec<u8>) -> std::io::Result<bool> {
    read_bounded_event(reader, line, MAX_LINE)
}

fn read_bounded_event(
    reader: &mut impl BufRead,
    line: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<bool> {
    line.clear();
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(!line.is_empty());
        }
        let boundary = chunk.iter().position(|byte| *byte == b'\n');
        let count = boundary.map_or(chunk.len(), |index| index + 1);
        if line.len() + count > limit {
            return Err(std::io::Error::other("引擎输出行超过上限"));
        }
        line.extend_from_slice(&chunk[..count]);
        reader.consume(count);
        if boundary.is_some() {
            return Ok(true);
        }
    }
}

#[cfg(windows)]
fn wait_for_engine(
    process: &std::os::windows::io::OwnedHandle,
    job: &windows_job::Job,
    control: Option<&RunControl>,
    timeout: Option<Duration>,
    grace: Duration,
) -> (Option<u32>, bool) {
    let Some(control) = control else {
        return (windows_job::wait(process, None).ok().flatten(), false);
    };
    let started = Instant::now();
    let mut timed_out = false;
    loop {
        match windows_job::wait(process, Some(Duration::from_millis(25))) {
            Ok(Some(exit)) => return (Some(exit), timed_out),
            Ok(None) => {}
            Err(_) => break,
        }
        if !timed_out
            && control.requested_at().is_none()
            && timeout.is_some_and(|limit| started.elapsed() >= limit)
        {
            timed_out = true;
            let _ = control.request_stop();
        }
        if control
            .requested_at()
            .is_some_and(|at| at.elapsed() >= grace)
        {
            break;
        }
    }
    let _ = job.stop();
    (windows_job::wait(process, None).ok().flatten(), timed_out)
}

fn redact_output(value: &mut Value, secret: &str) {
    if secret.is_empty() {
        return;
    }
    match value {
        Value::String(text) if text.contains(secret) => *text = text.replace(secret, "[已隐藏]"),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| redact_output(item, secret)),
        Value::Object(items) => {
            if items.keys().any(|key| key.contains(secret)) {
                *items = std::mem::take(items)
                    .into_iter()
                    .map(|(key, item)| (key.replace(secret, "[已隐藏]"), item))
                    .collect();
            }
            items
                .values_mut()
                .for_each(|item| redact_output(item, secret));
        }
        _ => {}
    }
}

#[cfg(windows)]
fn capture(
    app: AppHandle,
    process: std::os::windows::io::OwnedHandle,
    mut stdin: std::fs::File,
    stdout: std::fs::File,
    stderr: Option<std::fs::File>,
    input: Vec<u8>,
    shared: Arc<SharedStatus>,
    job: Arc<windows_job::Job>,
    finance: Option<FinanceRun>,
) {
    let finance = finance.as_ref();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            if stdin.write_all(&input).is_err() {
                let _ = job.stop();
            }
            drop(stdin);
        });
        let output = scope.spawn(|| {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            let limit = if finance.is_some() {
                MAX_FINANCE_LINE
            } else {
                MAX_LINE
            };
            let result = (|| -> Result<(), ()> {
                while read_bounded_event(&mut reader, &mut line, limit).map_err(|_| ())? {
                    let mut value = serde_json::from_slice::<Value>(&line).map_err(|_| ())?;
                    if let Some(finance) = finance {
                        redact_output(&mut value, &finance.token);
                    }
                    let kind = value.get("type").and_then(Value::as_str).ok_or(())?;
                    if matches!(kind, "error" | "warning") {
                        let diagnostic = EngineError::diagnostic(&value);
                        value["code"] = json!(diagnostic.code);
                        value["message"] = json!(diagnostic.message);
                    }
                    if let Some(finance) = finance {
                        finance.forward(&app, &value);
                    }
                    shared.state.lock().map_err(|_| ())?.event(value);
                }
                Ok(())
            })();
            if result.is_err() {
                let _ = job.stop();
            }
            result
        });
        let stderr = finance
            .zip(stderr)
            .map(|(finance, stderr)| scope.spawn(move || finance.append_stderr(stderr)));
        let (exit, timed_out) = wait_for_engine(
            &process,
            &job,
            finance.map(|run| run.control.as_ref()),
            finance
                .filter(|run| !run.updating)
                .map(|_| finance::VERIFY_TIMEOUT),
            finance::CANCEL_GRACE,
        );
        // 即使主进程自行退出，也结束仍持有本次管道的后代。
        let _ = job.stop();
        let valid = output.join().is_ok_and(|result| result.is_ok());
        if let Some(stderr) = stderr {
            let _ = stderr.join();
        }
        if let Ok(mut status) = shared.state.lock() {
            let cancelled = status.cancel_requested
                || finance.is_some_and(|run| run.control.requested_at().is_some());
            let verify_missing_result = finance.is_some_and(|run| !run.updating)
                && !status
                    .result
                    .as_ref()
                    .is_some_and(|result| result["status"] == "ok");
            if timed_out {
                status.error = Some(EngineError::new(
                    "VERIFY_TIMEOUT",
                    "测试连接超时（约 60 秒），请检查网络后重试",
                ));
            } else if !valid {
                status.error.get_or_insert_with(|| {
                    EngineError::new(
                        "ENGINE_PROTOCOL",
                        "引擎输出不符合 JSON Lines 协议或超过大小上限",
                    )
                });
            } else if exit != Some(0) || verify_missing_result {
                status
                    .error
                    .get_or_insert_with(|| EngineError::new("ENGINE_EXIT", "引擎未正常完成"));
            }
            if let Some(finance) = finance {
                finance.control.cleanup();
                finance.forward(
                    &app,
                    &json!({
                        "type": "engine_exit", "code": exit, "cancelled": cancelled,
                    }),
                );
            }
            status.state = if cancelled && !timed_out {
                status.result = None;
                status.error = None;
                State::Cancelled
            } else if status.error.is_some() {
                State::Failed
            } else {
                State::Succeeded
            };
            let label = if status.state == State::Cancelled {
                "已取消引擎任务"
            } else {
                "引擎任务已结束"
            };
            status.log(label);
            shared.changed.notify_all();
        }
    });
}

fn active(task: &Task) -> bool {
    task.status
        .state
        .lock()
        .is_ok_and(|status| status.state == State::Running)
}

fn cancel(task: &Task, status: &mut TaskStatus) -> Result<(), EngineError> {
    if status.state != State::Running || status.cancel_requested {
        return Ok(());
    }
    if let Some(control) = &task.finance {
        status.cancel_requested = true;
        control.request_stop().map_err(|_| {
            EngineError::new(
                "ENGINE_CANCEL_FAILED",
                "无法写入停止信号，将尝试强制结束金融引擎",
            )
        })?;
    } else {
        #[cfg(windows)]
        task.job.stop().map_err(|_| "未能结束引擎进程树")?;
        status.cancel_requested = true;
    }
    Ok(())
}

pub fn stop_module(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<EngineState>();
    let (marker, tasks) = {
        let mut all = state.modules.lock().map_err(|_| "引擎状态不可用")?;
        let Some(tasks) = all.get_mut(id) else {
            return Ok(());
        };
        let marker = *tasks.stopping.get_or_insert_with(Uuid::new_v4);
        tasks.paths.clear();
        for task in &tasks.tasks {
            let mut status = task.status.state.lock().map_err(|_| "引擎任务状态不可用")?;
            // 金融的停止文件无法写入时仍有已经启动的 Job 强制结束计时器。
            if let Err(error) = cancel(task, &mut status)
                && task.finance.is_none()
            {
                return Err(error.message);
            }
        }
        (marker, tasks.tasks.clone())
    };
    // 等待子进程与读写线程结束，同时不占用模块注册表锁。
    for task in &tasks {
        drop(task.status.wait()?);
    }
    let mut all = state.modules.lock().map_err(|_| "引擎状态不可用")?;
    if all
        .get(id)
        .is_some_and(|tasks| tasks.stopping == Some(marker))
    {
        all.remove(id);
    }
    Ok(())
}

pub(crate) fn defer_exit(app: &AppHandle, code: i32) -> bool {
    let engines = app.state::<EngineState>();
    let Ok(all) = engines.modules.lock() else {
        return false;
    };
    let already_exiting = engines.exiting.swap(true, Ordering::SeqCst);
    if !all.values().any(|module| module.tasks.iter().any(active)) {
        return false;
    }
    if !already_exiting {
        let ids = all.keys().cloned().collect::<Vec<_>>();
        let app = app.clone();
        std::thread::spawn(move || {
            for id in ids {
                let _ = stop_module(&app, &id);
            }
            app.exit(code);
        });
    }
    true
}

enum Started {
    Task(Task),
    AlreadyRunning(String),
}

fn start(app: &AppHandle, id: &str, params: StartParams) -> Result<Value, EngineError> {
    let modules = app.state::<ModuleState>();
    let state = app.state::<EngineState>();
    if id != FINANCE_ID && !params.exec_paths.is_empty() {
        let paths = modules.with_active(id, "engine.exec_paths", |_| {
            let mut all = state.modules.lock().map_err(|_| "引擎状态不可用")?;
            Ok(selected_paths(all.entry(id.to_owned()).or_default(), &params)?.1)
        })?;
        let paths = paths
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let confirmed = app
            .dialog()
            .message(format!(
                "允许模块 {id} 将以下文件作为可执行路径交给完全信任的引擎？\n\n{paths}"
            ))
            .title("确认引擎执行路径")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show();
        if !confirmed {
            return Err("已取消执行路径授权".into());
        }
    }

    let finance = if id == FINANCE_ID {
        if !params.paths.is_empty() || !params.exec_paths.is_empty() {
            return Err(EngineError::new(
                "INVALID_REQUEST",
                "金融引擎使用固定缓存路径",
            ));
        }
        Some(
            serde_json::from_value::<EngineInput>(params.input.clone())
                .map_err(|_| EngineError::new("INVALID_REQUEST", "金融引擎启动参数无效"))?,
        )
    } else {
        None
    };
    let started = modules.with_active(id, "engine", |module| {
        Ok((|| -> Result<Started, EngineError> {
            if finance.is_some() && !module.grants.iter().any(|grant| grant == "finance") {
                return Err(EngineError::new("PERMISSION_DENIED", "金融指标权限已撤销"));
            }
            if !params.exec_paths.is_empty()
                && !module.grants.iter().any(|p| p == "engine.exec_paths")
            {
                return Err("缺少权限 engine.exec_paths".into());
            }
            if (!params.paths.is_empty() || !params.exec_paths.is_empty())
                && !module.grants.iter().any(|p| p == "dialog.open")
            {
                return Err("缺少权限 dialog.open".into());
            }
            let spec = module
                .manifest
                .engine
                .as_ref()
                .ok_or("模块未声明本地引擎")?;
            let mut all = state.modules.lock().map_err(|_| "引擎状态不可用")?;
            let tasks = all.entry(id.to_owned()).or_default();
            if state.exiting.load(Ordering::SeqCst) || tasks.stopping.is_some() {
                return Err(EngineError::new("ENGINE_BUSY", "应用或模块正在关闭"));
            }
            if tasks.tasks.iter().filter(|task| active(task)).count()
                >= usize::from(spec.concurrency)
            {
                if let Some(request) = &finance
                    && request.updating()
                    && let Some(task) = tasks
                        .tasks
                        .iter()
                        .find(|task| task.updating && active(task))
                {
                    return Ok(Started::AlreadyRunning(task.id.clone()));
                }
                return Err(EngineError::new(
                    "ENGINE_BUSY",
                    if finance.is_some() {
                        "金融引擎正在运行，请稍后重试"
                    } else {
                        "引擎已达到并发上限"
                    },
                ));
            }
            let (paths, exec_paths) = selected_paths(tasks, &params)?;
            let executable = verify_engine(&module.install_dir, spec)?;
            #[cfg(not(windows))]
            {
                let _ = (executable, paths, exec_paths);
                Err("本地引擎目前只支持 Windows".into())
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                // 校验后直到进程成功创建，禁止覆盖或删除引擎文件。
                let _file = std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode(1)
                    .open(&executable)
                    .map_err(|_| "无法锁定待启动的引擎文件")?;
                let executable = verify_engine(&module.install_dir, spec)?;
                let run = finance
                    .as_ref()
                    .map(|request| FinanceRun::prepare(app, request))
                    .transpose()?;
                let payload = run.as_ref().map(FinanceRun::input).unwrap_or_else(|| {
                    json!({
                        "input": params.input, "paths": paths, "execPaths": exec_paths,
                    })
                });
                let mut input = serde_json::to_vec(&payload).map_err(|_| "引擎输入无效")?;
                if input.len() >= MAX_LINE {
                    return Err("引擎输入超过 64 KiB".into());
                }
                input.push(b'\n');
                module.ensure_runtime_dirs()?;
                let environment = run.as_ref().map(FinanceRun::environment);
                let windows_job::Process {
                    job,
                    process,
                    stdin,
                    stdout,
                    stderr,
                } = windows_job::launch(
                    &executable,
                    &module.data_dir,
                    run.as_ref().map_or(&[], |run| run.arguments.as_slice()),
                    environment.as_ref().map_or(&[], |vars| vars.as_slice()),
                    run.is_some(),
                )
                .map_err(|_| {
                    EngineError::new("ENGINE_START_FAILED", "无法将模块引擎作为 Windows Job 启动")
                })?;
                let updating = run.as_ref().is_some_and(|run| run.updating);
                let control = run.as_ref().map(|run| run.control.clone());
                let job = Arc::new(job);
                let status = Arc::new(SharedStatus::default());
                let worker_status = status.clone();
                let worker_job = job.clone();
                let worker_app = app.clone();
                std::thread::Builder::new()
                    .spawn(move || {
                        capture(
                            worker_app,
                            process,
                            stdin,
                            stdout,
                            stderr,
                            input,
                            worker_status,
                            worker_job,
                            run,
                        )
                    })
                    .map_err(|_| "无法创建引擎监控线程")?;
                for handle in params.paths.iter().chain(&params.exec_paths) {
                    tasks.paths.remove(handle);
                }
                if tasks.tasks.len() >= MAX_TASKS
                    && let Some(index) = tasks.tasks.iter().position(|task| !active(task))
                {
                    tasks.tasks.remove(index);
                }
                let task = Task {
                    id: Uuid::new_v4().to_string(),
                    status,
                    job,
                    finance: control,
                    updating,
                };
                tasks.tasks.push_back(task.clone());
                Ok(Started::Task(task))
            }
        })())
    })??;
    match started {
        Started::AlreadyRunning(id) => Ok(json!({ "taskId": id, "alreadyRunning": true })),
        Started::Task(task) => {
            if finance.as_ref().is_some_and(|request| !request.updating()) {
                let status = task.status.wait()?;
                if status.state != State::Succeeded {
                    return Err(status
                        .error
                        .clone()
                        .unwrap_or_else(|| EngineError::new("ENGINE_EXIT", "测试连接未完成")));
                }
            }
            Ok(json!({ "taskId": task.id }))
        }
    }
}

fn call(app: &AppHandle, id: &str, method: &str, params: Value) -> Result<Value, EngineError> {
    if method == "start" {
        let params = serde_json::from_value(params).map_err(|_| "引擎启动参数无效")?;
        return start(app, id, params);
    }
    Ok(app
        .state::<ModuleState>()
        .with_active(id, "engine", |module| {
            if id == FINANCE_ID && !module.grants.iter().any(|grant| grant == "finance") {
                return Err("金融指标权限已撤销".into());
            }
            if method == "probe" {
                if params != json!({}) {
                    return Err("引擎探测不接受参数".into());
                }
                let spec = module
                    .manifest
                    .engine
                    .as_ref()
                    .ok_or("模块未声明本地引擎")?;
                return Ok(match verify_engine(&module.install_dir, spec) {
                    Ok(_) if cfg!(windows) => json!({ "available": true }),
                    Ok(_) => json!({ "available": false, "error": "本地引擎目前只支持 Windows" }),
                    Err(error) => json!({ "available": false, "error": error }),
                });
            }
            let shortcut = id == FINANCE_ID && method == "cancel" && params == json!({});
            let params = if shortcut {
                None
            } else {
                let parsed: TaskParams =
                    serde_json::from_value(params).map_err(|_| "引擎任务参数无效")?;
                Some(parsed)
            };
            let state = app.state::<EngineState>();
            let all = state.modules.lock().map_err(|_| "引擎状态不可用")?;
            let task = all.get(id).and_then(|module| {
                module.tasks.iter().find(|task| {
                    params.as_ref().map_or_else(
                        || task.updating && active(task),
                        |params| task.id == params.task_id,
                    )
                })
            });
            let Some(task) = task else {
                return if shortcut {
                    Ok(Value::Null)
                } else {
                    Err("引擎任务不存在".into())
                };
            };
            let mut status = task.status.state.lock().map_err(|_| "引擎任务状态不可用")?;
            match method {
                "progress" => Ok(status.snapshot()),
                "logs" => Ok(json!(status.logs)),
                "cancel" => {
                    cancel(task, &mut status).map_err(|error| error.message)?;
                    Ok(Value::Null)
                }
                _ => Err("未知引擎方法".into()),
            }
        })?)
}

#[tauri::command]
pub async fn module_engine_call(
    window: WebviewWindow,
    id: String,
    method: String,
    params: Value,
) -> Result<Value, EngineError> {
    only_main(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || call(&app, &id, &method, params))
        .await
        .map_err(|_| "引擎服务不可用")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_limit_rejects_oversize_line_without_retaining_it() {
        let input = vec![b'x'; MAX_LINE + 1];
        let mut line = Vec::new();
        assert!(read_event(&mut BufReader::new(&input[..]), &mut line).is_err());
        assert!(line.len() <= MAX_LINE);
    }

    #[test]
    fn official_finance_completion_with_full_history_has_a_separate_bounded_limit() {
        let value = json!({ "type": "done", "status": "ok", "new_dates": {
            "valuation.test": vec!["20261123"; 6_000],
        } });
        let mut input = serde_json::to_vec(&value).unwrap();
        input.push(b'\n');
        assert!(input.len() > MAX_LINE);
        let mut line = Vec::new();
        assert!(read_event(&mut BufReader::new(input.as_slice()), &mut line).is_err());
        assert!(
            read_bounded_event(
                &mut BufReader::new(input.as_slice()),
                &mut line,
                MAX_FINANCE_LINE
            )
            .unwrap()
        );
        assert_eq!(serde_json::from_slice::<Value>(&line).unwrap(), value);
    }

    #[test]
    fn finance_output_redacts_secret_after_json_escapes_are_decoded() {
        let mut value: Value = serde_json::from_str(r#"{"type":"error","code":"TOKEN_INVALID","message":"token \u0073ynthetic", "raw":{"synthetic": ["prefix synthetic"]}}"#).unwrap();
        redact_output(&mut value, "synthetic");
        let error = EngineError::diagnostic(&value);
        assert_eq!(error.code, "TOKEN_INVALID");
        assert_eq!(error.message, "token [已隐藏]");
        assert!(!value.to_string().contains("synthetic"));
    }

    #[cfg(windows)]
    #[test]
    fn verify_timeout_requests_stop_then_forces_a_nonresponsive_job() {
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("fixture.rs");
        let executable = fixture.path().join("fixture.exe");
        std::fs::write(
            &source,
            r#"
use std::{path::PathBuf, time::Duration};
fn main() {
    let mut args = std::env::args_os().skip(1);
    if args.next().unwrap() == "ignore" {
        std::thread::sleep(Duration::from_secs(30));
    } else {
        let flag = PathBuf::from(args.next().unwrap());
        while !flag.is_file() { std::thread::sleep(Duration::from_millis(10)); }
    }
}
"#,
        )
        .unwrap();
        assert!(
            std::process::Command::new("rustc")
                .arg(&source)
                .arg("-o")
                .arg(&executable)
                .status()
                .unwrap()
                .success()
        );
        for (behavior, code) in [("graceful", 0), ("ignore", 1)] {
            let control = RunControl::new(fixture.path(), None).unwrap();
            let args = [behavior.into(), control.cancel_file().into_os_string()];
            let process =
                windows_job::launch(&executable, fixture.path(), &args, &[], false).unwrap();
            let (exit, timed_out) = wait_for_engine(
                &process.process,
                &process.job,
                Some(&control),
                Some(Duration::from_millis(75)),
                Duration::from_millis(650),
            );
            assert_eq!((exit, timed_out), (Some(code), true), "{behavior}");
            assert!(control.cancel_file().is_file());
            let scratch = control.cancel_file().parent().unwrap().to_owned();
            drop(control);
            assert!(!scratch.exists());
        }
    }

    #[test]
    fn logs_keep_only_host_labels_and_cap_entries() {
        let mut status = TaskStatus::default();
        for _ in 0..150 {
            status.event(json!({ "type": "warning", "message": "synthetic-secret" }));
        }
        status.event(json!({ "type": "error", "message": "synthetic-secret" }));
        assert_eq!(status.logs.len(), 128);
        assert!(!format!("{:?}", status.logs).contains("synthetic-secret"));
        assert_eq!(status.error.unwrap().message, "引擎报告错误");
    }

    #[test]
    fn progress_keeps_current_and_valid_error_survives_failed_done() {
        let mut status = TaskStatus::default();
        status.event(json!({ "type":"progress", "done":1, "total":3, "current":"20261120" }));
        status.event(
            json!({ "type":"error", "code":"TOKEN_INVALID", "message":"Tushare token 无效" }),
        );
        status.event(json!({ "type":"done", "status":"failed" }));
        let actual = status.snapshot();
        assert_eq!(
            actual["progress"],
            json!({ "done":1, "total":3, "current":"20261120" })
        );
        assert_eq!(
            actual["error"],
            json!({ "code":"TOKEN_INVALID", "message":"Tushare token 无效" })
        );
        assert!(status.logs.iter().all(|log| !log.contains("Tushare")));
    }

    #[test]
    fn error_codes_and_messages_are_bounded() {
        for invalid in ["lowercase", "BAD-CODE", "A1", "", &"A".repeat(41)] {
            let error = EngineError::diagnostic(&json!({ "code":invalid, "message":"不显示" }));
            assert_eq!(
                (error.code.as_str(), error.message.as_str()),
                ("ENGINE_ERROR", "引擎报告错误")
            );
        }
        let error = EngineError::diagnostic(
            &json!({ "code":"PERMISSION_DENIED", "message":format!("\u{001b}{}", "积".repeat(450)) }),
        );
        assert_eq!(error.code, "PERMISSION_DENIED");
        assert_eq!(error.message, "积".repeat(400));
    }

    #[test]
    fn path_handles_are_scoped_expiring_and_cannot_repeat() {
        let mut one = ModuleTasks::default();
        one.paths.insert(
            "test".into(),
            SelectedPath {
                path: PathBuf::from("fixture.txt"),
                expiry: Instant::now() + PATH_TTL,
            },
        );
        let mut params = StartParams {
            input: Value::Null,
            paths: vec!["test".into()],
            exec_paths: vec![],
        };
        assert!(selected_paths(&mut one, &params).is_ok());
        assert!(selected_paths(&mut ModuleTasks::default(), &params).is_err());
        params.exec_paths.push("test".into());
        assert!(selected_paths(&mut one, &params).is_err());
        params.exec_paths.clear();
        one.paths.get_mut("test").unwrap().expiry = Instant::now();
        assert!(selected_paths(&mut one, &params).is_err());
    }
}
