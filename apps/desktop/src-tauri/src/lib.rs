mod database;
mod desktop;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(desktop::ShellState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|argument| argument == "--background") {
                desktop::request(app, "open");
            }
        }))
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
                    ],
                )
                .build(),
        )
        .setup(|app| {
            desktop::setup(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
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
            desktop::exit_app
        ])
        .run(tauri::generate_context!())
        .expect("启动 WorkBench 失败");
}
