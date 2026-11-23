use super::{
    archive::{StagedPackage, linked, module_file, ordinary_dir, verify_engine},
    manifest::{CORE_ID, Credential, Manifest, valid_id},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tempfile::NamedTempFile;
use uuid::Uuid;

const MAX_STORAGE: u64 = 10 * 1024 * 1024;
const MAX_RECORD: u64 = 256 * 1024;
const PREVIEW_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const RECORD: &str = ".installed.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Installed {
    manifest: Manifest,
    grants: Vec<String>,
}

#[derive(Clone)]
pub struct ActiveModule {
    pub manifest: Manifest,
    pub grants: Vec<String>,
    pub install_dir: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    token: String,
}

#[derive(Serialize)]
pub struct ModuleRecord {
    manifest: Manifest,
    grants: Vec<String>,
    url: String,
}

#[derive(Serialize)]
pub struct ModuleList {
    modules: Vec<ModuleRecord>,
    pending: Vec<String>,
}

#[derive(Serialize)]
pub struct Preview {
    ticket: String,
    manifest: Manifest,
}

struct PendingPackage {
    ticket: String,
    expires_at: Instant,
    staged: StagedPackage,
}

#[derive(Default)]
pub struct ModuleState(Mutex<Option<ModuleStore>>);

pub struct ModuleStore {
    root: PathBuf,
    identifier: String,
    host_version: String,
    active: BTreeMap<String, ActiveModule>,
    pending: BTreeMap<String, Manifest>,
    preview: Option<PendingPackage>,
}

impl ActiveModule {
    fn new(root: &Path, record: Installed) -> Result<Self, String> {
        let directory = root.join(&record.manifest.id);
        ordinary_dir(&directory)?;
        let install_dir = directory.join(&record.manifest.version);
        ordinary_dir(&install_dir)?;
        Ok(Self {
            manifest: record.manifest,
            grants: record.grants,
            install_dir,
            data_dir: directory.join("data"),
            cache_dir: directory.join("cache"),
            token: Uuid::new_v4().simple().to_string(),
        })
    }

    pub fn origin_path(&self) -> String {
        if cfg!(any(windows, target_os = "android")) {
            format!(
                "http://wbpkg.localhost/{}/{}/",
                self.manifest.id, self.token
            )
        } else {
            format!("wbpkg://{}/{}/", self.manifest.id, self.token)
        }
    }

    fn record(&self) -> ModuleRecord {
        ModuleRecord {
            manifest: self.manifest.clone(),
            grants: self.grants.clone(),
            url: format!("{}{}", self.origin_path(), self.manifest.entry),
        }
    }

    pub fn asset(&self, token: &str, relative: &str) -> Result<PathBuf, String> {
        if self.token != token
            || self
                .manifest
                .engine
                .as_ref()
                .is_some_and(|e| e.path.eq_ignore_ascii_case(relative))
        {
            return Err("模块资源不可用".into());
        }
        ordinary_dir(self.install_dir.parent().ok_or("模块目录无效")?)?;
        module_file(&self.install_dir, relative)
    }

    pub fn ensure_runtime_dirs(&self) -> Result<(), String> {
        ordinary_dir(self.install_dir.parent().ok_or("模块目录无效")?)?;
        ensure_dir(&self.data_dir)?;
        ensure_dir(&self.cache_dir)
    }
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => ordinary_dir(path),
        Err(_) => Err("无法建立模块目录".into()),
    }
}

fn read_json<T: DeserializeOwned>(path: &Path, limit: u64) -> Result<Option<T>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !linked(&metadata) && metadata.len() <= limit => {}
        Ok(_) => return Err("模块状态文件不是普通文件或大小超限".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取模块状态文件".into()),
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "无法打开模块状态文件")?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取模块状态文件")?;
    if bytes.len() as u64 > limit {
        return Err("模块状态文件大小超限".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "模块状态不是有效 JSON".into())
}

fn write_json(path: &Path, value: &impl Serialize, limit: u64) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "无法编码模块状态")?;
    if bytes.len() as u64 > limit {
        return Err(if limit == MAX_STORAGE {
            "模块 storage 超过 10 MiB"
        } else {
            "模块状态文件大小超限"
        }
        .into());
    }
    let parent = path.parent().ok_or("模块状态目录无效")?;
    ordinary_dir(parent)?;
    let mut file = NamedTempFile::new_in(parent).map_err(|_| "无法创建模块状态临时文件")?;
    file.write_all(&bytes)
        .and_then(|()| file.as_file().sync_all())
        .map_err(|_| "无法写入模块状态")?;
    file.persist(path).map_err(|_| "无法提交模块状态")?;
    Ok(())
}

fn remove_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法清理模块状态文件".into()),
    }
}

fn remove_dir(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Ok(metadata) if metadata.is_dir() && !linked(&metadata) => {
            fs::remove_dir_all(path).map_err(|_| "无法清理模块目录，可能仍有文件在使用".into())
        }
        _ => Err("拒绝清理异常模块目录".into()),
    }
}

fn delete_credential(identifier: &str, id: &str, credential: &Credential) -> Result<(), String> {
    let target = format!(
        "{identifier}:module:{id}:{}:{}",
        credential.service, credential.account
    );
    let entry = keyring::Entry::new_with_target(&target, &credential.service, &credential.account)
        .map_err(|_| "无法定位模块凭据")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法删除模块凭据".into()),
    }
}

impl ModuleState {
    pub fn initialize(
        &self,
        root: PathBuf,
        identifier: String,
        host_version: String,
    ) -> Result<(), String> {
        let store = ModuleStore::new(root, identifier, host_version)?;
        store.resume_native();
        *self.0.lock().map_err(|_| "模块运行时不可用")? = Some(store);
        Ok(())
    }

    pub fn lock(&self) -> Result<MutexGuard<'_, Option<ModuleStore>>, String> {
        self.0.lock().map_err(|_| "模块运行时不可用".into())
    }

    pub fn with_store<T>(
        &self,
        action: impl FnOnce(&mut ModuleStore) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.lock()?;
        action(guard.as_mut().ok_or("模块运行时未初始化")?)
    }

    pub fn with_active<T>(
        &self,
        id: &str,
        permission: &str,
        action: impl FnOnce(&ActiveModule) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_store(|store| {
            let module = store.active(id)?;
            if !module.grants.iter().any(|grant| grant == permission) {
                return Err("模块权限未授予或已撤销".into());
            }
            action(module)
        })
    }
}

impl ModuleStore {
    fn new(root: PathBuf, identifier: String, host_version: String) -> Result<Self, String> {
        ensure_dir(&root)?;
        let mut store = Self {
            root,
            identifier,
            host_version,
            active: BTreeMap::new(),
            pending: BTreeMap::new(),
            preview: None,
        };
        ensure_dir(&store.journal_dir())?;
        // 上次应用退出时遗留的未确认包没有生效，可以直接丢弃。
        remove_dir(&store.staging_dir())?;
        ensure_dir(&store.staging_dir())?;
        for item in fs::read_dir(store.journal_dir()).map_err(|_| "无法读取模块卸载日志")?
        {
            let entry = item.map_err(|_| "无法读取模块卸载日志")?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            if let Some(manifest) = read_json::<Manifest>(&path, MAX_RECORD)? {
                manifest.validate(&store.host_version)?;
                if path.file_stem().and_then(|stem| stem.to_str()) != Some(&manifest.id) {
                    return Err("模块卸载日志 ID 不匹配".into());
                }
                store.pending.insert(manifest.id.clone(), manifest);
            }
        }
        for item in fs::read_dir(&store.root).map_err(|_| "无法读取模块目录")? {
            let path = item.map_err(|_| "无法读取模块目录")?.path();
            let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !valid_id(id) || id == CORE_ID || store.pending.contains_key(id) {
                continue;
            }
            match store.load_active(&path, id) {
                Ok(Some(module)) => {
                    store.active.insert(id.to_owned(), module);
                }
                Ok(None) => {}
                Err(error) => eprintln!("模块 {id} 未加载：{error}"),
            }
        }
        Ok(store)
    }

    fn load_active(&self, directory: &Path, id: &str) -> Result<Option<ActiveModule>, String> {
        ordinary_dir(directory)?;
        let Some(record) = read_json::<Installed>(&directory.join(RECORD), MAX_RECORD)? else {
            return Ok(None);
        };
        record.manifest.validate(&self.host_version)?;
        if record.manifest.id != id
            || record
                .grants
                .iter()
                .any(|p| !record.manifest.permissions.contains(p))
        {
            return Err("已安装模块清单或授权不一致".into());
        }
        ActiveModule::new(&self.root, record).map(Some)
    }

    pub fn staging_dir(&self) -> PathBuf {
        self.root.join(".staging")
    }
    pub fn host_version(&self) -> &str {
        &self.host_version
    }
    fn journal_dir(&self) -> PathBuf {
        self.root.join(".removing")
    }
    fn journal(&self, id: &str) -> PathBuf {
        self.journal_dir().join(format!("{id}.json"))
    }

    pub fn active(&self, id: &str) -> Result<&ActiveModule, String> {
        ordinary_dir(&self.root)?;
        self.active
            .get(id)
            .ok_or_else(|| "模块未安装或正在清理".into())
    }

    pub fn list(&mut self) -> ModuleList {
        if self
            .preview
            .as_ref()
            .is_some_and(|preview| preview.expires_at <= Instant::now())
        {
            self.preview = None;
        }
        ModuleList {
            modules: self.active.values().map(ActiveModule::record).collect(),
            pending: self.pending.keys().cloned().collect(),
        }
    }

    pub fn preview(&mut self, staged: StagedPackage) -> Result<Preview, String> {
        let id = &staged.manifest.id;
        if self.active.contains_key(id)
            || self.pending.contains_key(id)
            || self.root.join(id).exists()
        {
            return Err("同 ID 模块已安装或正在清理，请先完成卸载".into());
        }
        let ticket = Uuid::new_v4().simple().to_string();
        let manifest = staged.manifest.clone();
        self.preview = Some(PendingPackage {
            ticket: ticket.clone(),
            expires_at: Instant::now() + PREVIEW_TIMEOUT,
            staged,
        });
        Ok(Preview { ticket, manifest })
    }

    pub fn discard(&mut self, ticket: &str) {
        if self
            .preview
            .as_ref()
            .is_some_and(|preview| preview.ticket == ticket)
        {
            self.preview = None;
        }
    }

    pub fn install(&mut self, ticket: &str) -> Result<ModuleRecord, String> {
        if self
            .preview
            .as_ref()
            .is_none_or(|current| current.ticket != ticket || current.expires_at <= Instant::now())
        {
            return Err("模块安装确认已失效，请重新选择包".into());
        }
        let current = self.preview.take().ok_or("模块安装确认不存在")?;
        let manifest = current.staged.manifest;
        let destination = self.root.join(&manifest.id);
        if self.active.contains_key(&manifest.id)
            || self.pending.contains_key(&manifest.id)
            || destination.exists()
        {
            return Err("模块 ID 已占用或正在清理".into());
        }
        ordinary_dir(&self.root)?;
        ordinary_dir(&self.staging_dir())?;
        let install_dir = current.staged.dir.path().join(&manifest.version);
        module_file(&install_dir, &manifest.entry)?;
        if let Some(engine) = &manifest.engine {
            verify_engine(&install_dir, engine)?;
        }
        let record = Installed {
            grants: manifest.permissions.clone(),
            manifest,
        };
        write_json(&current.staged.dir.path().join(RECORD), &record, MAX_RECORD)?;
        fs::rename(current.staged.dir.path(), &destination).map_err(|_| "无法原子发布模块目录")?;
        let module = ActiveModule::new(&self.root, record)?;
        let result = module.record();
        self.active.insert(module.manifest.id.clone(), module);
        Ok(result)
    }

    pub fn mark_uninstall(&mut self, id: &str) -> Result<bool, String> {
        if id == CORE_ID {
            return Err("综合工作台属于核心，只能隐藏".into());
        }
        if !valid_id(id) {
            return Err("模块 ID 无效".into());
        }
        if self.pending.contains_key(id) {
            return Ok(true);
        }
        let Some(active) = self.active.get(id) else {
            return Ok(false);
        };
        let manifest = active.manifest.clone();
        ordinary_dir(&self.root)?;
        write_json(&self.journal(id), &manifest, MAX_RECORD)?;
        self.pending.insert(id.to_owned(), manifest);
        self.active.remove(id);
        Ok(true)
    }

    pub fn cleanup_native(&self, id: &str) -> Result<(), String> {
        self.cleanup_with(id, delete_credential)
    }

    fn cleanup_with(
        &self,
        id: &str,
        delete: impl Fn(&str, &str, &Credential) -> Result<(), String>,
    ) -> Result<(), String> {
        if let Some(manifest) = self.pending.get(id) {
            ordinary_dir(&self.root)?;
            for credential in &manifest.uninstall.credentials {
                delete(&self.identifier, id, credential)?;
            }
            // 版本文件、引擎、缓存、私有数据库、storage 和设置都以模块目录为边界。
            remove_dir(&self.root.join(id))?;
        }
        Ok(())
    }

    fn resume_native(&self) {
        for id in self.pending.keys() {
            if let Err(error) = self.cleanup_native(id) {
                eprintln!("模块 {id} 清理将重试：{error}");
            }
        }
    }

    pub fn finish_uninstall(&mut self, id: &str) -> Result<(), String> {
        if !self.pending.contains_key(id) {
            return Ok(());
        }
        ordinary_dir(&self.root)?;
        ordinary_dir(&self.journal_dir())?;
        if !matches!(fs::symlink_metadata(self.root.join(id)), Err(error) if error.kind() == ErrorKind::NotFound)
        {
            return Err("模块原生清理尚未完成".into());
        }
        remove_file(&self.journal(id))?;
        self.pending.remove(id);
        Ok(())
    }

    pub fn revoke(&mut self, id: &str, permission: &str) -> Result<ModuleRecord, String> {
        let module = self.active(id)?;
        if !module
            .manifest
            .permissions
            .iter()
            .any(|item| item == permission)
        {
            return Err("模块没有声明此权限".into());
        }
        let grants = module
            .grants
            .iter()
            .filter(|item| *item != permission)
            .cloned()
            .collect::<Vec<_>>();
        let directory = self.root.join(id);
        let record = Installed {
            manifest: module.manifest.clone(),
            grants,
        };
        write_json(&directory.join(RECORD), &record, MAX_RECORD)?;
        let module = self.active.get_mut(id).ok_or("模块未安装")?;
        module.grants = record.grants;
        Ok(module.record())
    }
}

pub fn storage_read(module: &ActiveModule) -> Result<BTreeMap<String, Value>, String> {
    if !module.data_dir.exists() {
        return Ok(BTreeMap::new());
    }
    ordinary_dir(module.data_dir.parent().ok_or("模块数据目录无效")?)?;
    ordinary_dir(&module.data_dir)?;
    Ok(read_json(&module.data_dir.join("storage.json"), MAX_STORAGE)?.unwrap_or_default())
}

pub fn storage_write(
    module: &ActiveModule,
    key: String,
    value: Option<Value>,
    remove: bool,
) -> Result<(), String> {
    if key.is_empty() || key.encode_utf16().count() > 128 || key.chars().any(char::is_control) {
        return Err("模块 storage 键无效".into());
    }
    module.ensure_runtime_dirs()?;
    let mut storage = storage_read(module)?;
    if remove {
        storage.remove(&key);
    } else {
        storage.insert(key, value.unwrap_or(Value::Null));
    }
    write_json(&module.data_dir.join("storage.json"), &storage, MAX_STORAGE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;
    use tempfile::TempDir;

    const MODULE: &str = "com.example.pomodoro";

    fn fixture() -> (TempDir, ModuleStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = ModuleStore::new(
            dir.path().join("modules"),
            "com.example.isolated".into(),
            "0.1.0".into(),
        )
        .unwrap();
        (dir, store)
    }

    fn install(store: &mut ModuleStore, permissions: &[&str]) -> Result<ModuleRecord, String> {
        let manifest: Manifest = serde_json::from_value(json!({
            "id": MODULE,
            "name": "合成测试模块",
            "version": "1.0.0",
            "minHostVersion": "0.1.0",
            "entry": "index.html",
            "permissions": permissions,
            "uninstall": {
                "credentials": [{"service":"fixture","account":"test"}],
                "tables": ["pomodoro_history"],
                "settingsPrefixes": ["prefs."]
            }
        }))
        .unwrap();
        manifest.validate(store.host_version())?;
        let dir = TempDir::new_in(store.staging_dir()).unwrap();
        fs::create_dir(dir.path().join("1.0.0")).unwrap();
        fs::write(dir.path().join("1.0.0/index.html"), "<p>fixture</p>").unwrap();
        let preview = store.preview(StagedPackage { manifest, dir })?;
        store.install(&preview.ticket)
    }

    #[test]
    fn uninstall_resumes_after_failed_credentials_and_releases_all_private_state() {
        let (dir, mut store) = fixture();
        install(&mut store, &["storage", "notifications"]).unwrap();
        let active = store.active(MODULE).unwrap();
        storage_write(active, "count".into(), Some(json!(3)), false).unwrap();
        fs::write(
            active.data_dir.join("private.db"),
            b"fixture private module database",
        )
        .unwrap();
        fs::write(
            active.data_dir.join("settings.json"),
            b"fixture module settings",
        )
        .unwrap();
        fs::write(active.cache_dir.join("cache.txt"), b"fixture cache").unwrap();
        assert!(store.mark_uninstall(MODULE).unwrap());
        assert!(store.active(MODULE).is_err());
        assert!(
            store
                .cleanup_with(MODULE, |_, _, _| Err("模拟凭据删除失败".into()))
                .is_err()
        );
        assert!(store.finish_uninstall(MODULE).is_err());
        drop(store);

        let mut reboot = ModuleStore::new(
            dir.path().join("modules"),
            "com.example.isolated".into(),
            "0.1.0".into(),
        )
        .unwrap();
        assert_eq!(reboot.list().pending, vec![MODULE]);
        assert!(reboot.active(MODULE).is_err());
        assert!(install(&mut reboot, &["storage"]).is_err());
        let credentials = RefCell::new(vec![("fixture".to_string(), "test".to_string())]);
        for _ in 0..2 {
            reboot
                .cleanup_with(MODULE, |identifier, id, item| {
                    assert_eq!(identifier, "com.example.isolated");
                    assert_eq!(id, MODULE);
                    credentials.borrow_mut().retain(|(service, account)| {
                        service != &item.service || account != &item.account
                    });
                    Ok(())
                })
                .unwrap();
        }
        assert!(credentials.into_inner().is_empty());
        assert!(!reboot.root.join(MODULE).exists());
        reboot.finish_uninstall(MODULE).unwrap();
        assert!(reboot.list().pending.is_empty());
        assert!(!reboot.journal(MODULE).exists());
        let reinstalled = install(&mut reboot, &["storage"]).unwrap();
        assert_eq!(reinstalled.manifest.id, MODULE);
        assert!(
            storage_read(reboot.active(MODULE).unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn revoke_survives_reload_and_core_uninstall_is_rejected() {
        let (dir, mut store) = fixture();
        install(&mut store, &["storage", "notifications"]).unwrap();
        assert_eq!(
            store.revoke(MODULE, "storage").unwrap().grants,
            vec!["notifications"]
        );
        assert!(
            store
                .mark_uninstall(CORE_ID)
                .unwrap_err()
                .contains("只能隐藏")
        );
        let runtime = ModuleState::default();
        runtime
            .initialize(
                dir.path().join("modules"),
                "com.example.isolated".into(),
                "0.1.0".into(),
            )
            .unwrap();
        assert!(
            runtime
                .with_active(MODULE, "storage", storage_read)
                .unwrap_err()
                .contains("已撤销")
        );
        assert!(
            runtime
                .with_active(MODULE, "notifications", |_| Ok(()))
                .is_ok()
        );
    }

    #[test]
    fn storage_rejects_utf8_overage_without_losing_existing_values() {
        let (_dir, mut store) = fixture();
        install(&mut store, &["storage"]).unwrap();
        let module = store.active(MODULE).unwrap();
        storage_write(module, "count".into(), Some(json!(3)), false).unwrap();
        let multi_byte = "钟".repeat((MAX_STORAGE / 3) as usize);
        assert!(
            storage_write(module, "large".into(), Some(json!(multi_byte)), false)
                .unwrap_err()
                .contains("10 MiB")
        );
        assert_eq!(
            storage_read(module).unwrap(),
            BTreeMap::from([("count".into(), json!(3))])
        );
    }

    #[cfg(windows)]
    #[test]
    fn deletes_only_the_exact_windows_credential() {
        struct Fixture(keyring::Entry);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = self.0.delete_credential();
            }
        }
        let identifier = format!(
            "com.example.module-runtime-test.{}",
            Uuid::new_v4().simple()
        );
        let credential = Credential {
            service: "fixture".into(),
            account: "test".into(),
        };
        let fixture = |id: &str| {
            let target = format!("{identifier}:module:{id}:fixture:test");
            let entry =
                Fixture(keyring::Entry::new_with_target(&target, "fixture", "test").unwrap());
            entry.0.set_password("synthetic test data").unwrap();
            entry
        };
        let removed = fixture(MODULE);
        let neighbor = fixture("com.example.other");
        delete_credential(&identifier, MODULE, &credential).unwrap();
        delete_credential(&identifier, MODULE, &credential).unwrap();
        assert!(matches!(
            removed.0.get_password(),
            Err(keyring::Error::NoEntry)
        ));
        assert_eq!(neighbor.0.get_password().unwrap(), "synthetic test data");
    }
}
