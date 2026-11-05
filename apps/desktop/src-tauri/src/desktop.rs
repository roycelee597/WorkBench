use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, WebviewWindow,
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};

#[derive(Default)]
pub struct ShellState(Mutex<Vec<String>>);

pub fn show(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}
pub fn request(app: &AppHandle, kind: &str) {
    if kind == "open" || kind == "new-reminder" {
        let _ = show(app);
    }
    app.state::<ShellState>()
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(kind.to_owned());
    let _ = app.emit("shell-requests", ());
}
fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("只有主窗口可以控制桌面生命周期".into())
    }
}
#[tauri::command]
pub fn take_shell_requests(window: WebviewWindow, app: AppHandle) -> Result<Vec<String>, String> {
    main_only(&window)?;
    Ok(app
        .state::<ShellState>()
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .drain(..)
        .collect())
}
#[tauri::command]
pub fn hide_main(window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    window.hide().map_err(|error| error.to_string())
}
#[tauri::command]
pub fn show_main(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    main_only(&window)?;
    show(&app)
}
#[tauri::command]
pub fn exit_app(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    main_only(&window)?;
    app.exit(0);
    Ok(())
}

pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 WorkBench", true, None::<&str>)?;
    let new = MenuItem::with_id(app, "new-reminder", "新建提醒", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &new, &exit])?;
    let mut tray = TrayIconBuilder::with_id("workbench-tray")
        .tooltip("WorkBench")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| request(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                request(tray.app_handle(), "open");
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    if std::env::args().any(|argument| argument == "--background") {
        if let Some(window) = app.get_webview_window("main") {
            window.hide()?;
        }
    }
    Ok(())
}
