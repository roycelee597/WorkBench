use serde::Deserialize;
use serde_json::Value;
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

pub const DATABASE_URL: &str = "sqlite:workbench.db";

#[derive(Deserialize)]
pub struct Statement {
    query: String,
    values: Vec<Value>,
}

// SQL 插件的独立 IPC 调用不保证使用同一连接；联动写入在此共用一个事务。
// 此处只执行通用 SQL，所有业务决策、参数和语句均由 TypeScript 仓库产生。
#[tauri::command]
pub async fn execute_batch(
    window: tauri::WebviewWindow,
    databases: State<'_, DbInstances>,
    statements: Vec<Statement>,
) -> Result<Vec<u64>, String> {
    if window.label() != "main" {
        return Err("只有主窗口可以访问本地数据库".into());
    }
    let databases = databases.0.read().await;
    let Some(DbPool::Sqlite(pool)) = databases.get(DATABASE_URL) else {
        return Err("本地数据库尚未初始化".into());
    };
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    let mut affected = Vec::with_capacity(statements.len());
    for statement in &statements {
        let mut query = sqlx::query(&statement.query);
        for value in &statement.values {
            query = match value {
                Value::Null => query.bind(Option::<String>::None),
                Value::String(value) => query.bind(value),
                Value::Number(value) if value.is_i64() => query.bind(value.as_i64().unwrap()),
                Value::Number(value) if value.is_f64() => query.bind(value.as_f64().unwrap()),
                _ => return Err("SQL 参数仅允许字符串、数字或 null".into()),
            };
        }
        let result = query
            .execute(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
        affected.push(result.rows_affected());
    }
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())?;
    Ok(affected)
}
