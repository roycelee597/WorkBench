#[cfg(windows)]
mod windows_job;

use crate::module_runtime::{ModuleState, local_path, only_main, pick_path, verify_engine};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use uuid::Uuid;

const MAX_LINE: usize = 64 * 1024;
const MAX_TASKS: usize = 16;
const MAX_HANDLES: usize = 32;
const PATH_TTL: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct EngineState(Mutex<HashMap<String, ModuleTasks>>);

#[derive(Default)]
struct ModuleTasks {
    paths: HashMap<String, SelectedPath>,
    tasks: VecDeque<Task>,
}

struct SelectedPath {
    path: PathBuf,
    expiry: Instant,
}

struct Task {
    id: String,
    status: Arc<Mutex<TaskStatus>>,
    #[cfg(windows)]
    job: Arc<windows_job::Job>,
}

#[derive(Default)]
struct TaskStatus {
    state: State,
    progress: Option<Value>,
    result: Option<Value>,
    error: Option<&'static str>,
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
        if let Some(error) = self.error {
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
        // 日志只使用宿主固定文案。结果对象是 SDK 数据，禁止写日志。
        match value.get("type").and_then(Value::as_str) {
            Some("hello") => self.log("引擎已连接"),
            Some("stage") => self.log("进入下一阶段"),
            Some("warning") => self.log("引擎报告警告"),
            Some("progress") => {
                self.progress = Some(json!({
                    "done": value["done"].as_u64(),
                    "total": value["total"].as_u64(),
                }));
            }
            Some("done" | "result") => {
                if value["status"] == "failed" {
                    self.error = Some("引擎报告任务失败");
                } else {
                    self.result = Some(value);
                }
            }
            Some("error") => {
                self.error = Some("引擎报告错误");
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
        let mut all = state.0.lock().map_err(|_| "引擎状态不可用")?;
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

fn read_event(reader: &mut impl BufRead, line: &mut Vec<u8>) -> std::io::Result<bool> {
    line.clear();
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(!line.is_empty());
        }
        let boundary = chunk.iter().position(|byte| *byte == b'\n');
        let count = boundary.map_or(chunk.len(), |index| index + 1);
        if line.len() + count > MAX_LINE {
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
fn capture(
    process: std::os::windows::io::OwnedHandle,
    mut stdin: std::fs::File,
    stdout: std::fs::File,
    input: Vec<u8>,
    status: Arc<Mutex<TaskStatus>>,
    job: Arc<windows_job::Job>,
) {
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
            let result = (|| -> Result<(), ()> {
                while read_event(&mut reader, &mut line).map_err(|_| ())? {
                    let value = serde_json::from_slice::<Value>(&line).map_err(|_| ())?;
                    if !value.get("type").is_some_and(Value::is_string) {
                        return Err(());
                    }
                    status.lock().map_err(|_| ())?.event(value);
                }
                Ok(())
            })();
            if result.is_err() {
                let _ = job.stop();
            }
            result
        });
        let exit = windows_job::wait(&process);
        // 主进程结束时也回收子进程，令继承 stdout 的子进程关闭管道。
        let _ = job.stop();
        let valid = output.join().is_ok_and(|result| result.is_ok());
        if let Ok(mut status) = status.lock()
            && status.state == State::Running
        {
            if !valid {
                status.error = Some("引擎输出不符合 JSON Lines 协议或超过大小上限");
            } else if exit.ok() != Some(0) {
                status.error.get_or_insert("引擎异常退出");
            }
            status.state = if status.error.is_some() {
                State::Failed
            } else {
                State::Succeeded
            };
            status.log("引擎任务已结束");
        }
    });
}

fn cancel(task: &Task, status: &mut TaskStatus) -> Result<(), String> {
    if status.state == State::Running {
        #[cfg(windows)]
        task.job.stop().map_err(|_| "未能结束引擎进程树")?;
        #[cfg(not(windows))]
        let _ = task;
        status.state = State::Cancelled;
        status.result = None;
        status.log("已取消引擎任务");
    }
    Ok(())
}

pub fn stop_module(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<EngineState>();
    let mut all = state.0.lock().map_err(|_| "引擎状态不可用")?;
    if let Some(tasks) = all.get_mut(id) {
        tasks.paths.clear();
        for task in &tasks.tasks {
            let mut status = task.status.lock().map_err(|_| "引擎任务状态不可用")?;
            cancel(task, &mut status)?;
        }
    }
    all.remove(id);
    Ok(())
}

pub fn stop_all(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let ids = state
        .0
        .lock()
        .map(|tasks| tasks.keys().cloned().collect::<Vec<_>>());
    if let Ok(ids) = ids {
        for id in ids {
            let _ = stop_module(app, &id);
        }
    }
}

fn start(app: &AppHandle, id: &str, params: StartParams) -> Result<Value, String> {
    let modules = app.state::<ModuleState>();
    let state = app.state::<EngineState>();
    if !params.exec_paths.is_empty() {
        let paths = modules.with_active(id, "engine.exec_paths", |_| {
            let mut all = state.0.lock().map_err(|_| "引擎状态不可用")?;
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

    modules.with_active(id, "engine", |module| {
        if !params.exec_paths.is_empty() && !module.grants.iter().any(|p| p == "engine.exec_paths")
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
        let mut all = state.0.lock().map_err(|_| "引擎状态不可用")?;
        let tasks = all.entry(id.to_owned()).or_default();
        let active = |task: &Task| task.status.lock().is_ok_and(|s| s.state == State::Running);
        if tasks.tasks.iter().filter(|task| active(task)).count() >= usize::from(spec.concurrency) {
            return Err("引擎已达到并发上限".into());
        }
        let (paths, exec_paths) = selected_paths(tasks, &params)?;
        let mut input = serde_json::to_vec(&json!({
            "input": params.input, "paths": paths, "execPaths": exec_paths,
        }))
        .map_err(|_| "引擎输入无效")?;
        if input.len() >= MAX_LINE {
            return Err("引擎输入超过 64 KiB".into());
        }
        input.push(b'\n');
        let executable = verify_engine(&module.install_dir, spec)?;
        #[cfg(not(windows))]
        {
            let _ = executable;
            Err("本地引擎目前只支持 Windows".into())
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // 保持只读共享句柄直到创建进程，避免校验后替换引擎。
            let _file = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(&executable)
                .map_err(|_| "无法锁定待启动的引擎文件")?;
            let executable = verify_engine(&module.install_dir, spec)?;
            module.ensure_runtime_dirs()?;
            let windows_job::Process {
                job,
                process,
                stdin,
                stdout,
            } = windows_job::launch(&executable, &module.data_dir)
                .map_err(|_| "无法将模块引擎作为 Windows Job 启动")?;
            let job = Arc::new(job);
            let worker_job = job.clone();
            let status = Arc::new(Mutex::new(TaskStatus::default()));
            let worker_status = status.clone();
            std::thread::Builder::new()
                .spawn(move || capture(process, stdin, stdout, input, worker_status, worker_job))
                .map_err(|_| "无法创建引擎监控线程")?;
            for handle in params.paths.iter().chain(&params.exec_paths) {
                tasks.paths.remove(handle);
            }
            if tasks.tasks.len() >= MAX_TASKS
                && let Some(index) = tasks.tasks.iter().position(|task| !active(task))
            {
                tasks.tasks.remove(index);
            }
            let id = Uuid::new_v4().to_string();
            tasks.tasks.push_back(Task {
                id: id.clone(),
                status,
                job,
            });
            Ok(json!({ "taskId": id }))
        }
    })
}

fn call(app: &AppHandle, id: &str, method: &str, params: Value) -> Result<Value, String> {
    if method == "start" {
        let params = serde_json::from_value(params).map_err(|_| "引擎启动参数无效")?;
        return start(app, id, params);
    }
    app.state::<ModuleState>()
        .with_active(id, "engine", |module| {
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
            let params: TaskParams =
                serde_json::from_value(params).map_err(|_| "引擎任务参数无效")?;
            let state = app.state::<EngineState>();
            let all = state.0.lock().map_err(|_| "引擎状态不可用")?;
            let task = all
                .get(id)
                .and_then(|module| module.tasks.iter().find(|task| task.id == params.task_id))
                .ok_or("引擎任务不存在")?;
            let mut status = task.status.lock().map_err(|_| "引擎任务状态不可用")?;
            match method {
                "progress" => Ok(status.snapshot()),
                "logs" => Ok(json!(status.logs)),
                "cancel" => {
                    cancel(task, &mut status)?;
                    Ok(Value::Null)
                }
                _ => Err("未知引擎方法".into()),
            }
        })
}

#[tauri::command]
pub async fn module_engine_call(
    window: WebviewWindow,
    id: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
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
    fn logs_keep_only_host_labels_and_cap_entries() {
        let mut status = TaskStatus::default();
        for _ in 0..150 {
            status.event(json!({ "type": "warning", "message": "synthetic-secret" }));
        }
        status.event(json!({ "type": "error", "message": "synthetic-secret" }));
        assert_eq!(status.logs.len(), 128);
        assert!(!format!("{:?}", status.logs).contains("synthetic-secret"));
        assert_eq!(status.error, Some("引擎报告错误"));
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
