mod archive;
mod manifest;
mod official;
mod state;

pub use archive::verify_engine;
pub use manifest::FINANCE_ID;
pub use state::ModuleState;

use archive::stage_package;
use state::{ModuleList, ModuleRecord, Preview, storage_read, storage_write};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
use tauri::{
    AppHandle, Manager, State, UriSchemeContext, WebviewWindow, Wry, async_runtime,
    http::{Method, Request, Response, StatusCode, Uri},
};
use tauri_plugin_dialog::DialogExt;

pub fn setup(app: &AppHandle) -> Result<(), String> {
    let parent = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法定位模块数据目录")?;
    std::fs::create_dir_all(&parent).map_err(|_| "无法建立应用数据目录")?;
    archive::ordinary_dir(&parent)?;
    let state = app.state::<ModuleState>();
    state.initialize(
        parent.join("modules"),
        app.config().identifier.clone(),
        app.package_info().version.to_string(),
        Some(official::LegacyFinancePaths::from_app(app, parent)?),
    )?;
    if let Err(error) = state.with_store(|store| {
        store.ensure_official(&official::FINANCE, true, || {
            official::package_path(app, &official::FINANCE)
        })
    }) {
        eprintln!("官方金融模块尚未迁移，可在模块管理重试：{error}");
    }
    Ok(())
}

pub(crate) fn only_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main"
        || window
            .url()
            .ok()
            .is_none_or(|url| url.scheme() == "wbpkg" || url.host_str() == Some("wbpkg.localhost"))
    {
        return Err("只有主窗口可以管理模块".into());
    }
    Ok(())
}

pub(crate) fn local_path(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let Some(Component::Prefix(prefix)) = path.components().next() else {
            return false;
        };
        let (Prefix::Disk(drive) | Prefix::VerbatimDisk(drive)) = prefix.kind() else {
            return false;
        };
        let root = [u16::from(drive), u16::from(b':'), u16::from(b'\\'), 0];
        // GetDriveTypeW: 可移动介质、固定磁盘、光盘、RAM 磁盘属于本地驱动器。
        let drive_type =
            unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(root.as_ptr()) };
        if !matches!(drive_type, 2 | 3 | 5 | 6) {
            return false;
        }
    }
    let ancestors = path
        .ancestors()
        .filter(|item| item.has_root())
        .collect::<Vec<_>>();
    ancestors.into_iter().rev().all(|item| {
        std::fs::symlink_metadata(item).is_ok_and(|metadata| !archive::linked(&metadata))
    })
}

pub async fn pick_path(
    app: &AppHandle,
    directory: bool,
    extension: Option<&'static str>,
) -> Result<Option<PathBuf>, String> {
    let app = app.clone();
    async_runtime::spawn_blocking(move || {
        let main = app.get_webview_window("main").ok_or("主窗口不可用")?;
        let mut picker = app.dialog().file().set_parent(&main);
        if let Some(extension) = extension {
            picker = picker
                .add_filter("WorkBench 模块包", &[extension])
                .set_title("选择本地模块包");
        } else {
            picker = picker.set_title(if directory {
                "选择模块可使用的文件夹"
            } else {
                "选择模块可使用的文件"
            });
        }
        let chosen = if directory {
            picker.blocking_pick_folder()
        } else {
            picker.blocking_pick_file()
        };
        chosen
            .map(|path| {
                path.into_path()
                    .map_err(|_| "请选择本地文件系统路径".into())
            })
            .transpose()
    })
    .await
    .map_err(|_| "文件选择窗口不可用")?
}

#[tauri::command]
pub fn module_list(
    window: WebviewWindow,
    state: State<'_, ModuleState>,
) -> Result<ModuleList, String> {
    only_main(&window)?;
    state.with_store(|store| Ok(store.list()))
}

#[tauri::command]
pub async fn module_preview(window: WebviewWindow) -> Result<Option<Preview>, String> {
    only_main(&window)?;
    let app = window.app_handle().clone();
    let Some(path) = pick_path(&app, false, Some("wbpkg")).await? else {
        return Ok(None);
    };
    let state = app.state::<ModuleState>();
    let (staging, host_version) =
        state.with_store(|store| Ok((store.staging_dir(), store.host_version().to_owned())))?;
    async_runtime::spawn_blocking(move || {
        if !local_path(&path) {
            return Err("模块包必须位于本地磁盘，且不能经过链接".into());
        }
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| "模块包不存在")?;
        if !metadata.is_file() || archive::linked(&metadata) {
            return Err("模块包必须是普通本地文件".into());
        }
        let staged = stage_package(&path, &staging, &host_version)?;
        app.state::<ModuleState>()
            .with_store(|store| store.preview(staged).map(Some))
    })
    .await
    .map_err(|_| "模块包预检未完成")?
}

#[tauri::command]
pub async fn install_module(window: WebviewWindow, ticket: String) -> Result<ModuleRecord, String> {
    only_main(&window)?;
    let app = window.app_handle().clone();
    async_runtime::spawn_blocking(move || {
        app.state::<ModuleState>()
            .with_store(|store| store.install(&ticket))
    })
    .await
    .map_err(|_| "模块安装未完成")?
}

#[tauri::command]
pub async fn module_reinstall_bundled(
    window: WebviewWindow,
    id: String,
) -> Result<ModuleRecord, String> {
    only_main(&window)?;
    let descriptor = official::descriptor(&id).ok_or("没有附带此官方模块")?;
    let app = window.app_handle().clone();
    async_runtime::spawn_blocking(move || {
        app.state::<ModuleState>().with_store(|store| {
            store
                .ensure_official(descriptor, false, || {
                    official::package_path(&app, descriptor)
                })?
                .ok_or_else(|| "未能安装官方模块".into())
        })
    })
    .await
    .map_err(|_| "官方模块安装未完成")?
}

#[tauri::command]
pub fn module_discard(
    window: WebviewWindow,
    state: State<'_, ModuleState>,
    ticket: String,
) -> Result<(), String> {
    only_main(&window)?;
    state.with_store(|store| {
        store.discard(&ticket);
        Ok(())
    })
}

#[tauri::command]
pub async fn uninstall_module(window: WebviewWindow, id: String) -> Result<(), String> {
    only_main(&window)?;
    let app = window.app_handle().clone();
    let should_cleanup = app
        .state::<ModuleState>()
        .with_store(|store| store.mark_uninstall(&id))?;
    if !should_cleanup {
        return Ok(());
    }
    let stop_app = app.clone();
    let stop_id = id.clone();
    async_runtime::spawn_blocking(move || crate::module_engine::stop_module(&stop_app, &stop_id))
        .await
        .map_err(|_| "模块进程未能退出")??;
    if id == FINANCE_ID {
        crate::finance::close_reader(&app).await;
    }
    async_runtime::spawn_blocking(move || {
        app.state::<ModuleState>()
            .with_store(|store| store.cleanup_native(&id))
    })
    .await
    .map_err(|_| "模块卸载未完成")?
}

#[tauri::command]
pub fn module_finish_uninstall(
    window: WebviewWindow,
    state: State<'_, ModuleState>,
    id: String,
) -> Result<(), String> {
    only_main(&window)?;
    state.with_store(|store| store.finish_uninstall(&id))
}

#[tauri::command]
pub async fn module_revoke(
    window: WebviewWindow,
    id: String,
    permission: String,
) -> Result<ModuleRecord, String> {
    only_main(&window)?;
    let app = window.app_handle().clone();
    let close_reader = id == FINANCE_ID && permission == "finance";
    let revoke_app = app.clone();
    let record = async_runtime::spawn_blocking(move || -> Result<ModuleRecord, String> {
        let record = app
            .state::<ModuleState>()
            .with_store(|store| store.revoke(&id, &permission))?;
        if matches!(
            permission.as_str(),
            "engine" | "engine.exec_paths" | "dialog.open" | "finance"
        ) {
            crate::module_engine::stop_module(&app, &id)?;
        }
        Ok(record)
    })
    .await
    .map_err(|_| "模块权限更新未完成")??;
    if close_reader {
        crate::finance::close_reader(&revoke_app).await;
    }
    Ok(record)
}

#[tauri::command]
pub fn module_storage_read(
    window: WebviewWindow,
    state: State<'_, ModuleState>,
    id: String,
) -> Result<BTreeMap<String, serde_json::Value>, String> {
    only_main(&window)?;
    state.with_active(&id, "storage", storage_read)
}

#[tauri::command]
pub fn module_storage_write(
    window: WebviewWindow,
    state: State<'_, ModuleState>,
    id: String,
    key: String,
    value: Option<serde_json::Value>,
    remove: bool,
) -> Result<(), String> {
    only_main(&window)?;
    state.with_active(&id, "storage", |module| {
        storage_write(module, key, value, remove)
    })
}

fn resource(uri: &Uri) -> Option<(&str, &str, &str)> {
    // Wry 将 Windows 的 HTTP 地址还原成 wbpkg://localhost 后发送给处理器。
    let authority = uri.authority()?;
    let path = uri.path().strip_prefix('/')?;
    let (id, rest) = if cfg!(any(windows, target_os = "android")) {
        if uri.scheme_str() != Some("wbpkg") || authority.as_str() != "localhost" {
            return None;
        }
        path.split_once('/')?
    } else {
        if uri.scheme_str() != Some("wbpkg") {
            return None;
        }
        (authority.as_str(), path)
    };
    let (token, relative) = rest.split_once('/')?;
    if !manifest::valid_id(id)
        || token.len() != 32
        || !token.bytes().all(|c| c.is_ascii_hexdigit())
        || !manifest::valid_path(relative)
    {
        return None;
    }
    Some((id, token, relative))
}

fn content_type(path: &str) -> Option<&'static str> {
    let (_, ext) = path.rsplit_once('.')?;
    match ext.to_ascii_lowercase().as_str() {
        "html" => Some("text/html; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        _ => None,
    }
}

const MAX_ASSET: u64 = 16 * 1024 * 1024;

fn read_asset(state: &ModuleState, uri: &Uri) -> Option<(Vec<u8>, &'static str, String)> {
    let (id, token, relative) = resource(uri)?;
    let mime = content_type(relative)?;
    let mut body = Vec::new();
    let (path, scope) = state
        .with_store(|store| {
            let module = store.active(id)?;
            Ok((module.asset(token, relative)?, module.origin_path()))
        })
        .ok()?;
    File::open(path)
        .ok()?
        .take(MAX_ASSET + 1)
        .read_to_end(&mut body)
        .ok()?;
    if body.len() as u64 > MAX_ASSET {
        return None;
    }
    let csp = format!(
        "default-src 'none'; script-src {scope}; style-src {scope}; img-src {scope} data:; font-src {scope}; \
         connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; \
         base-uri 'none'; sandbox allow-scripts allow-forms"
    );
    Some((body, mime, csp))
}

pub fn protocol(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let state = context.app_handle().state::<ModuleState>();
    let response = if context.webview_label() == "main" && request.method() == Method::GET {
        read_asset(&state, request.uri())
    } else {
        None
    };
    let builder = Response::builder()
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), clipboard-read=(), clipboard-write=()");
    if let Some((body, mime, csp)) = response {
        builder
            .header("Content-Type", mime)
            .header("Content-Security-Policy", csp)
            // 模块脚本使用浏览器 CORS 路径，不透明 iframe 的 Origin 为 null。
            .header("Access-Control-Allow-Origin", "null")
            .body(body)
            .unwrap_or_default()
    } else {
        builder
            .status(StatusCode::NOT_FOUND)
            .header("Content-Type", "text/plain; charset=utf-8")
            .header("Content-Security-Policy", "default-src 'none'; sandbox")
            .body(Vec::new())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_never_accepts_nonportable_or_nested_state_paths() {
        let token = "0123456789abcdef0123456789abcdef";
        let base = if cfg!(windows) {
            format!("wbpkg://localhost/com.example.test/{token}/")
        } else {
            format!("wbpkg://com.example.test/{token}/")
        };
        let parse = |path: &str| format!("{base}{path}").parse::<Uri>().unwrap();
        assert_eq!(
            resource(&parse("assets/chunk.js")),
            Some(("com.example.test", token, "assets/chunk.js"))
        );
        for path in [
            "../data/file.js",
            "%2e%2e/file.js",
            "a%2fb.js",
            "//app.js",
            ".installed.json",
            "nul.txt",
        ] {
            assert!(resource(&parse(path)).is_none(), "{path}");
        }
        assert!(content_type("manifest.json").is_none());
        assert!(content_type("engine.exe").is_none());
    }
}
