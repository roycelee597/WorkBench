mod ai;
mod database;
mod desktop;
mod finance;
mod module_engine;
mod module_runtime;
mod quick_create;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(desktop::ShellState::default())
        .manage(quick_create::QuickState::default())
        .manage(finance::FinanceState::default())
        .manage(ai::AiState::default())
        .manage(module_runtime::ModuleState::default())
        .manage(module_engine::EngineState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // 包协议只用于不透明 iframe，禁止在有权限的顶层 WebView 打开。
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("module-navigation")
                .on_navigation(|_, url| {
                    url.scheme() != "wbpkg" && url.host_str() != Some("wbpkg.localhost")
                })
                .build(),
        )
        .register_uri_scheme_protocol("wbpkg", module_runtime::protocol)
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|argument| argument == "--background") {
                desktop::request(app, "open");
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--background"])
                .build(),
        )
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(
                    database::DATABASE_URL,
                    vec![
                        tauri_plugin_sql::Migration {
                            version: 1,
                            description: "初始化工作台数据表",
                            sql: include_str!("../migrations/0001_init.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 2,
                            description: "提醒调度起点与实例状态",
                            sql: include_str!("../migrations/0002_reminder_scheduler.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 3,
                            description: "金融阈值与评估状态",
                            sql: include_str!("../migrations/0003_finance.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 4,
                            description: "本机 AI 对话记录",
                            sql: include_str!("../migrations/0004_ai.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 5,
                            description: "模块备忘录所有权",
                            sql: include_str!("../migrations/0005_module_memo_owner.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                    ],
                )
                .build(),
        )
        .setup(|app| {
            if let Err(error) = module_runtime::setup(app.handle()) {
                eprintln!("模块运行时不可用：{error}");
            }
            ai::setup(app.handle());
            desktop::setup(app)?;
            quick_create::setup(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "quick-create" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    desktop::request(window.app_handle(), "hide");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            database::execute_batch,
            desktop::take_shell_requests,
            desktop::hide_main,
            desktop::show_main,
            desktop::exit_app,
            finance::finance_token_set,
            ai::ai_key_set,
            ai::ai_key_status,
            ai::ai_key_clear,
            ai::ai_key_test,
            ai::ai_chat,
            ai::ai_get_call_limits,
            ai::ai_set_call_limits,
            ai::ai_open_platform,
            finance::finance_token_status,
            finance::finance_token_clear,
            finance::finance_update_start,
            finance::finance_update_cancel,
            finance::finance_verify,
            finance::finance_db_path,
            finance::finance_db_size,
            finance::finance_reader_open,
            finance::finance_reader_close,
            finance::finance_open_directory,
            quick_create::open_quick_create,
            quick_create::hide_quick_create,
            quick_create::quick_request,
            quick_create::take_quick_requests,
            quick_create::finish_quick_request,
            module_runtime::module_list,
            module_runtime::module_preview,
            module_runtime::install_module,
            module_runtime::module_discard,
            module_runtime::uninstall_module,
            module_runtime::module_finish_uninstall,
            module_runtime::module_revoke,
            module_runtime::module_storage_read,
            module_runtime::module_storage_write,
            module_engine::module_dialog_open,
            module_engine::module_engine_call,
        ])
        .build(tauri::generate_context!())
        .expect("启动 WorkBench 失败")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                module_engine::stop_all(app);
            }
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if finance::defer_exit(app, code.unwrap_or(0)) {
                    api.prevent_exit();
                }
            }
        });
}
