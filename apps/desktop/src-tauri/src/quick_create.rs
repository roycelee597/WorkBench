use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashSet, VecDeque},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Clone, Serialize)]
pub struct QuickRequest {
    id: String,
    payload: Value,
}
#[derive(Clone, Serialize)]
struct QuickReply {
    id: String,
    result: Value,
}
#[derive(Default)]
struct Queue {
    requests: Vec<QuickRequest>,
    active: HashSet<String>,
    completed: VecDeque<QuickReply>,
}
#[derive(Default)]
pub struct QuickState(Mutex<Queue>);
fn only(window: &WebviewWindow, label: &str) -> Result<(), String> {
    if window.label() == label {
        Ok(())
    } else {
        Err("此窗口无权执行快速新建操作".into())
    }
}
pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "quick-create", WebviewUrl::App("index.html".into()))
        .title("快速新建 · WorkBench")
        .inner_size(540.0, 560.0)
        .resizable(false)
        .always_on_top(true)
        .center()
        .visible(false)
        .skip_taskbar(true)
        .build()?;
    Ok(())
}
pub fn open(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("quick-create")
        .ok_or("快速新建窗口尚未就绪")?;
    let hidden = !window.is_visible().map_err(|error| error.to_string())?;
    if hidden {
        window.center().map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    if hidden {
        window
            .emit("quick-opened", ())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn open_quick_create(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, "main")?;
    open(&app)
}
#[tauri::command]
pub fn hide_quick_create(window: WebviewWindow) -> Result<(), String> {
    only(&window, "quick-create")?;
    window.hide().map_err(|error| error.to_string())
}
// 仅中转消息，不含业务或 SQL；参数由主窗口使用 zod 校验后，经统一 api.ts 执行。
#[tauri::command]
pub fn quick_request(
    window: WebviewWindow,
    app: AppHandle,
    id: String,
    payload: Value,
) -> Result<(), String> {
    only(&window, "quick-create")?;
    if id.len() != 36
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        || payload.to_string().len() > 100_000
    {
        return Err("快速新建消息无效或过长".into());
    }
    let state = app.state::<QuickState>();
    let mut queue = state.0.lock().map_err(|_| "快速新建队列不可用")?;
    if let Some(reply) = queue.completed.iter().find(|reply| reply.id == id) {
        return app
            .emit_to("quick-create", "quick-result", reply)
            .map_err(|error| error.to_string());
    }
    if queue.active.contains(&id) {
        return Ok(());
    }
    if queue.active.len() >= 16 {
        return Err("快速新建请求过多，请稍后重试".into());
    }
    queue.active.insert(id.clone());
    queue.requests.push(QuickRequest { id, payload });
    drop(queue);
    app.emit_to("main", "quick-requests", ())
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub fn take_quick_requests(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<Vec<QuickRequest>, String> {
    only(&window, "main")?;
    Ok(app
        .state::<QuickState>()
        .0
        .lock()
        .map_err(|_| "快速新建队列不可用")?
        .requests
        .drain(..)
        .collect())
}
#[tauri::command]
pub fn finish_quick_request(
    window: WebviewWindow,
    app: AppHandle,
    id: String,
    result: Value,
) -> Result<(), String> {
    only(&window, "main")?;
    if result.to_string().len() > 4096 {
        return Err("快速新建响应过长".into());
    }
    let state = app.state::<QuickState>();
    let mut queue = state.0.lock().map_err(|_| "快速新建队列不可用")?;
    if !queue.active.remove(&id) {
        return Err("快速新建请求不存在".into());
    }
    let reply = QuickReply { id, result };
    queue.completed.push_back(reply.clone());
    while queue.completed.len() > 64 {
        queue.completed.pop_front();
    }
    drop(queue);
    app.emit_to("quick-create", "quick-result", reply)
        .map_err(|error| error.to_string())
}
