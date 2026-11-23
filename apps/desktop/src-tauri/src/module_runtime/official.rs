use super::{archive::ordinary_dir, manifest::FINANCE_ID};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, path::BaseDirectory};

pub(super) struct OfficialModuleDescriptor {
    pub id: &'static str,
    pub resource: &'static str,
    pub migration: u8,
}

pub(super) const FINANCE: OfficialModuleDescriptor = OfficialModuleDescriptor {
    id: FINANCE_ID,
    resource: "official/finance.wbpkg",
    migration: 1,
};

pub(super) fn descriptor(id: &str) -> Option<&'static OfficialModuleDescriptor> {
    (id == FINANCE_ID).then_some(&FINANCE)
}

pub(super) fn package_path(
    app: &AppHandle,
    descriptor: &OfficialModuleDescriptor,
) -> Result<PathBuf, String> {
    let resource = app
        .path()
        .resolve(descriptor.resource, BaseDirectory::Resource);
    if let Ok(path) = &resource
        && super::local_path(path)
        && path.is_file()
    {
        return Ok(path.clone());
    }
    // 开发时由 beforeDevCommand 生成同一份包，路径不接受前端输入。
    #[cfg(debug_assertions)]
    {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("bundled/finance.wbpkg");
        if super::local_path(&path) && path.is_file() {
            return Ok(path);
        }
    }
    Err("安装包内的官方模块不可用，请检查 WorkBench 安装".into())
}

pub(super) struct LegacyFinancePaths {
    pub local: PathBuf,
    pub cache: PathBuf,
    pub logs: PathBuf,
}

fn directory_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        _ => ordinary_dir(path).map(|()| true),
    }
}

fn remove_files(directory: &Path, names: &[&str]) -> Result<(), String> {
    if directory_exists(directory)? {
        for name in names {
            match fs::remove_file(directory.join(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(_) => return Err("无法删除金融模块的旧数据文件".into()),
            }
        }
    }
    Ok(())
}

impl LegacyFinancePaths {
    pub fn from_app(app: &AppHandle, local: PathBuf) -> Result<Self, String> {
        let path = app.path();
        Ok(Self {
            local,
            cache: path.app_cache_dir().map_err(|_| "无法定位应用缓存目录")?,
            logs: path.app_log_dir().map_err(|_| "无法定位应用日志目录")?,
        })
    }

    pub fn cleanup(&self) -> Result<(), String> {
        remove_files(
            &self.local,
            &[
                "finance.db",
                "finance.db-wal",
                "finance.db-shm",
                "finance.db-journal",
                "finance.db.lock",
            ],
        )?;
        remove_files(&self.logs, &["finance-engine.log", "finance-engine.log.1"])?;
        if directory_exists(&self.cache)? {
            let runs = self.cache.join("finance-runs");
            if directory_exists(&runs)? {
                fs::remove_dir_all(runs).map_err(|_| "无法删除旧金融引擎临时目录")?;
            }
        }
        Ok(())
    }
}

pub(super) fn delete_legacy_finance_token(identifier: &str) -> Result<(), String> {
    // 使用旧版同一个凭据项，升级不读取、复制或改写 token。
    let entry = keyring::Entry::new(&format!("{identifier}.finance"), "tushare")
        .map_err(|_| "无法定位金融模块的旧凭据")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法删除金融模块的旧凭据".into()),
    }
}
