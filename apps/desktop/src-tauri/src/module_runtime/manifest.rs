use semver::Version;
use serde::{Deserialize, Deserializer, Serialize};
use std::{collections::HashSet, path::Path};

pub const CORE_ID: &str = "com.royce.workbench.general";
pub const FINANCE_ID: &str = "com.royce.workbench.finance";
pub const OFFICIAL_IDS: &[&str] = &[FINANCE_ID, "com.royce.workbench.ai"];
const PERMISSIONS: &[&str] = &[
    "storage",
    "notifications",
    "reminders:read",
    "reminders:write",
    "calendar:read",
    "calendar:write",
    "memos:read",
    "memos:write",
    "dialog.open",
    "engine",
    "engine.exec_paths",
    "finance",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub entry: String,
    pub min_host_version: String,
    pub permissions: Vec<String>,
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub engine: Option<EngineSpec>,
    #[serde(default, skip_serializing_if = "UninstallSpec::is_empty")]
    pub uninstall: UninstallSpec,
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    description: Option<String>,
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    author: Option<Author>,
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub icon: Option<String>,
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    license: Option<String>,
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    homepage: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EngineSpec {
    pub path: String,
    pub sha256: String,
    pub concurrency: u8,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct UninstallSpec {
    pub credentials: Vec<Credential>,
    pub tables: Vec<String>,
    pub settings_prefixes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Credential {
    pub service: String,
    pub account: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Author {
    name: String,
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    url: Option<String>,
}

fn non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl UninstallSpec {
    fn is_empty(&self) -> bool {
        self.credentials.is_empty() && self.tables.is_empty() && self.settings_prefixes.is_empty()
    }
}

fn ascii_name(value: &str, max: usize, allowed: impl Fn(u8) -> bool) -> bool {
    !value.is_empty() && value.len() <= max && value.bytes().all(allowed)
}

pub fn valid_id(value: &str) -> bool {
    value.len() <= 120
        && !windows_device(value)
        && value.split('.').count() >= 3
        && value.split('.').all(|label| {
            ascii_name(label, 63, |b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'
            }) && label.as_bytes()[0].is_ascii_lowercase()
                && !label.ends_with('-')
        })
}

fn windows_device(part: &str) -> bool {
    let stem = part
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
}

pub fn valid_path(value: &str) -> bool {
    value.len() <= 240
        && value.split('/').all(|part| {
            let edge = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
            if !ascii_name(part, 100, |b| edge(b) || b == b'.')
                || !edge(part.as_bytes()[0])
                || !edge(part.as_bytes()[part.len() - 1])
            {
                return false;
            }
            !windows_device(part)
        })
}

fn portable_version(value: &str) -> Option<Version> {
    let version = Version::parse(value).ok()?;
    (value.len() <= 64
        && [version.major, version.minor, version.patch]
            .into_iter()
            .all(|n| n <= 999_999_999))
    .then_some(version)
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.encode_utf16().count() <= max
}

fn valid_url(value: &str) -> bool {
    value.encode_utf16().count() <= 2048
        && tauri::Url::parse(value)
            .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some())
}

fn cleanup_name(value: &str) -> bool {
    ascii_name(value, 64, |b| {
        b.is_ascii_alphanumeric() || b"_.-".contains(&b)
    }) && (value.as_bytes()[0].is_ascii_alphanumeric() || value.starts_with('_'))
}

pub fn has_extension(path: &Path, expected: &str) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(expected))
}

impl Manifest {
    pub fn validate(&self, host_version: &str) -> Result<(), String> {
        if !valid_id(&self.id) || self.id == CORE_ID {
            return Err("模块 ID 格式无效或属于综合工作台".into());
        }
        if self.id != FINANCE_ID
            && self
                .permissions
                .iter()
                .any(|permission| permission == "finance")
        {
            return Err("金融数据权限仅限官方金融模块".into());
        }
        let minimum = portable_version(&self.min_host_version);
        if portable_version(&self.version).is_none() || minimum.is_none() {
            return Err("模块版本或最低宿主版本不是支持的语义化版本".into());
        }
        if portable_version(host_version)
            .zip(minimum)
            .is_none_or(|(host, min)| host.cmp_precedence(&min).is_lt())
        {
            return Err("此模块需要更高版本的 WorkBench".into());
        }
        if !valid_text(&self.name, 120)
            || self
                .description
                .as_deref()
                .is_some_and(|v| !valid_text(v, 1000))
            || self.license.as_deref().is_some_and(|v| !valid_text(v, 80))
            || self.homepage.as_deref().is_some_and(|v| !valid_url(v))
            || self.author.as_ref().is_some_and(|a| {
                !valid_text(&a.name, 120) || a.url.as_deref().is_some_and(|v| !valid_url(v))
            })
        {
            return Err("模块名称或描述信息格式无效".into());
        }
        if !valid_path(&self.entry)
            || !has_extension(Path::new(&self.entry), "html")
            || self.icon.as_deref().is_some_and(|item| !valid_path(item))
        {
            return Err("模块入口或图标路径格式无效".into());
        }
        let permissions = self
            .permissions
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        if permissions.len() != self.permissions.len()
            || permissions.iter().any(|p| !PERMISSIONS.contains(p))
        {
            return Err("模块包含未知或重复权限".into());
        }
        if let Some(engine) = &self.engine {
            if !valid_path(&engine.path)
                || !has_extension(Path::new(&engine.path), "exe")
                || engine.sha256.len() != 64
                || !engine.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                || !(1..=8).contains(&engine.concurrency)
            {
                return Err("模块引擎路径、SHA-256 或并发上限无效".into());
            }
        } else if permissions.contains("engine") {
            return Err("引擎权限要求清单声明本地引擎".into());
        }
        if permissions.contains("engine.exec_paths")
            && (!permissions.contains("engine") || !permissions.contains("dialog.open"))
        {
            return Err("执行路径权限要求同时声明引擎和文件选择权限".into());
        }
        let cleanup = &self.uninstall;
        if [
            cleanup.credentials.len(),
            cleanup.tables.len(),
            cleanup.settings_prefixes.len(),
        ]
        .into_iter()
        .any(|len| len > 64)
            || cleanup
                .credentials
                .iter()
                .any(|item| !cleanup_name(&item.service) || !cleanup_name(&item.account))
            || cleanup.tables.iter().any(|item| {
                !ascii_name(item, 63, |b| b.is_ascii_alphanumeric() || b == b'_')
                    || item.as_bytes()[0].is_ascii_digit()
                    || item.to_ascii_lowercase().starts_with("sqlite_")
            })
            || cleanup
                .settings_prefixes
                .iter()
                .any(|item| !cleanup_name(item))
        {
            return Err("卸载清理声明不符合模块私有命名规则".into());
        }
        if cleanup
            .credentials
            .iter()
            .map(|item| {
                (
                    item.service.to_ascii_lowercase(),
                    item.account.to_ascii_lowercase(),
                )
            })
            .collect::<HashSet<_>>()
            .len()
            != cleanup.credentials.len()
            || cleanup
                .tables
                .iter()
                .map(|item| item.to_ascii_lowercase())
                .collect::<HashSet<_>>()
                .len()
                != cleanup.tables.len()
            || cleanup
                .settings_prefixes
                .iter()
                .collect::<HashSet<_>>()
                .len()
                != cleanup.settings_prefixes.len()
        {
            return Err("卸载清理声明包含重复项目".into());
        }
        Ok(())
    }
}
