mod database;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .invoke_handler(tauri::generate_handler![database::execute_batch])
        .run(tauri::generate_context!())
        .expect("启动 WorkBench 失败");
}
