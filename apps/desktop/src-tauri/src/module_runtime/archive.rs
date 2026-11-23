use super::manifest::{EngineSpec, Manifest, OFFICIAL_IDS, has_extension, valid_path};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
use tempfile::TempDir;
use zip::ZipArchive;

const MAX_ENTRIES: usize = 2_048;
pub const MAX_EXTRACTED: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE: u64 = MAX_EXTRACTED + 1024 * 1024;
const MAX_MANIFEST: u64 = 128 * 1024;

pub struct StagedPackage {
    pub manifest: Manifest,
    pub dir: TempDir,
}

pub fn linked(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Windows 目录联接和其他重解析点也不得跟随。
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

pub fn ordinary_dir(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "模块目录不可用")?;
    if !metadata.is_dir() || linked(&metadata) {
        return Err("模块目录不是普通目录".into());
    }
    Ok(())
}

pub fn module_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if !valid_path(relative) {
        return Err("模块资源路径无效".into());
    }
    ordinary_dir(root)?;
    let mut path = root.to_path_buf();
    let mut segments = relative.split('/').peekable();
    while let Some(segment) = segments.next() {
        path.push(segment);
        let metadata = fs::symlink_metadata(&path).map_err(|_| "模块资源不存在")?;
        if linked(&metadata)
            || if segments.peek().is_some() {
                !metadata.is_dir()
            } else {
                !metadata.is_file()
            }
        {
            return Err("模块资源不是普通文件".into());
        }
    }
    Ok(path)
}

pub fn verify_engine(root: &Path, engine: &EngineSpec) -> Result<PathBuf, String> {
    let path = module_file(root, &engine.path)?;
    let file = File::open(&path).map_err(|_| "无法打开模块引擎")?;
    let mut hasher = Sha256::new();
    let read =
        io::copy(&mut file.take(MAX_EXTRACTED + 1), &mut hasher).map_err(|_| "无法读取模块引擎")?;
    if read > MAX_EXTRACTED
        || !format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(&engine.sha256)
    {
        return Err("模块引擎 SHA-256 不匹配".into());
    }
    Ok(path)
}

// V1 的大小/文件数不需要 ZIP64。先检查结束记录，限制 ZIP 解析器处理的条目数。
fn archive_entries<R: Read + Seek>(reader: &mut R) -> Result<usize, String> {
    let size = reader
        .seek(SeekFrom::End(0))
        .map_err(|_| "无法读取模块包")?;
    if !(22..=MAX_ARCHIVE).contains(&size) {
        return Err("模块包文件大小超限或 ZIP 格式无效".into());
    }
    let tail = size.min(65_577);
    reader
        .seek(SeekFrom::End(-(tail as i64)))
        .map_err(|_| "无法读取模块包")?;
    let mut buf = vec![0; tail as usize];
    reader.read_exact(&mut buf).map_err(|_| "无法读取模块包")?;
    let u16_at = |at| u16::from_le_bytes([buf[at], buf[at + 1]]);
    let u32_at = |at| u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);
    let pos = (0..=buf.len() - 22)
        .rev()
        .find(|&i| {
            buf[i..i + 4] == [0x50, 0x4b, 0x05, 0x06]
                && i + 22 + usize::from(u16_at(i + 20)) == buf.len()
        })
        .ok_or("模块包没有有效的 ZIP 结束记录")?;
    let count = usize::from(u16_at(pos + 10));
    let central_end = u64::from(u32_at(pos + 12)) + u64::from(u32_at(pos + 16));
    if u16_at(pos + 4) != 0
        || u16_at(pos + 6) != 0
        || usize::from(u16_at(pos + 8)) != count
        || !(1..=MAX_ENTRIES).contains(&count)
        || central_end > size - tail + pos as u64
        || (pos >= 20 && buf[pos - 20..pos - 16] == [0x50, 0x4b, 0x06, 0x07])
    {
        return Err("模块包 ZIP 条目超限或使用不支持的分卷格式".into());
    }
    reader.rewind().map_err(|_| "无法读取模块包")?;
    Ok(count)
}

fn extract<R: Read + Seek>(mut reader: R, stage: &Path, limit: u64) -> Result<(), String> {
    let expected = archive_entries(&mut reader)?;
    let mut archive = ZipArchive::new(reader).map_err(|_| "模块包不是有效的 ZIP")?;
    if archive.len() != expected {
        return Err("模块包包含重复条目或不一致的 ZIP 目录".into());
    }
    let mut total = 0;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| "无法读取 ZIP 条目")?;
        let is_dir = entry.is_dir();
        let raw = entry.name().map_err(|_| "ZIP 文件名编码无效")?;
        let raw = raw.as_ref();
        let name = if is_dir {
            raw.strip_suffix('/').unwrap_or(raw)
        } else {
            raw
        };
        // 拒绝 Windows 别名、路径穿越、绝对路径、反斜线和链接等非普通条目。
        if !valid_path(name)
            || !names.insert(name.to_ascii_lowercase())
            || entry
                .unix_mode()
                .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000))
        {
            return Err("模块包包含不安全路径、重复文件或链接".into());
        }
        if name.eq_ignore_ascii_case("manifest.json") && name != "manifest.json" {
            return Err("模块清单文件名必须为 manifest.json".into());
        }
        let output = stage.join(name);
        if is_dir {
            if entry.size() != 0 {
                return Err("ZIP 目录条目包含文件内容".into());
            }
            fs::create_dir_all(&output).map_err(|_| "无法创建模块临时目录")?;
            continue;
        }
        let remaining = limit - total;
        if entry.size() > remaining {
            return Err("模块包解压后大小超限".into());
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|_| "无法创建模块临时目录")?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|_| "模块包包含重复文件或文件无法写入")?;
        let written = io::copy(&mut entry.by_ref().take(remaining + 1), &mut file)
            .map_err(|_| "模块包解压失败")?;
        if written > remaining || written != entry.size() {
            return Err("模块包解压大小超限或内容不完整".into());
        }
        total += written;
    }
    Ok(())
}

pub fn stage_package(
    path: &Path,
    staging: &Path,
    host_version: &str,
) -> Result<StagedPackage, String> {
    if !has_extension(path, "wbpkg") {
        return Err("请选择以 .wbpkg 结尾的本地模块包".into());
    }
    ordinary_dir(staging)?;
    let dir = TempDir::new_in(staging).map_err(|_| "无法建立模块临时目录")?;
    let files = dir.path().join("archive");
    fs::create_dir(&files).map_err(|_| "无法建立模块临时目录")?;
    extract(
        File::open(path).map_err(|_| "无法打开模块包")?,
        &files,
        MAX_EXTRACTED,
    )?;
    let manifest_file = module_file(&files, "manifest.json")?;
    let mut bytes = Vec::new();
    File::open(manifest_file)
        .map_err(|_| "无法打开模块清单")?
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取模块清单")?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err("模块清单大小超限".into());
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| "模块清单 JSON 无效")?;
    manifest.validate(host_version)?;
    if OFFICIAL_IDS.contains(&manifest.id.as_str()) {
        return Err("此 ID 保留给安装包内置的官方模块".into());
    }
    module_file(&files, &manifest.entry)?;
    if let Some(icon) = &manifest.icon {
        module_file(&files, icon)?;
    }
    if let Some(engine) = &manifest.engine {
        verify_engine(&files, engine)?;
    }
    fs::rename(&files, dir.path().join(&manifest.version)).map_err(|_| "无法准备模块版本目录")?;
    Ok(StagedPackage { manifest, dir })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::{ZipWriter, write::SimpleFileOptions};

    fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in files {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn rejects_non_portable_paths_and_extraction_over_budget() {
        let tmp = tempfile::tempdir().unwrap();
        for name in [
            "../outside.txt",
            "a/../../outside.txt",
            "C:/test.txt",
            "aux.txt",
            "a\\b",
            "a.",
        ] {
            assert!(
                extract(Cursor::new(zip(&[(name, b"fixture")])), tmp.path(), 64).is_err(),
                "{name}"
            );
        }
        assert!(
            extract(
                Cursor::new(zip(&[("index.html", b"fixture")])),
                tmp.path(),
                3
            )
            .unwrap_err()
            .contains("大小超限")
        );
        assert!(!tmp.path().join("index.html").exists());
    }

    #[test]
    fn rejects_case_aliases() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(
            extract(
                Cursor::new(zip(&[("asset.js", b"a"), ("ASSET.js", b"b")])),
                tmp.path(),
                64
            )
            .unwrap_err()
            .contains("重复文件")
        );
    }

    #[test]
    fn verified_engine_fails_after_bytes_change() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("engine.exe");
        fs::write(&path, b"synthetic engine").unwrap();
        let engine = EngineSpec {
            path: "engine.exe".into(),
            sha256: format!("{:x}", Sha256::digest(b"synthetic engine")),
            concurrency: 1,
        };
        assert_eq!(verify_engine(tmp.path(), &engine).unwrap(), path);
        fs::write(&path, b"changed synthetic engine").unwrap();
        assert!(
            verify_engine(tmp.path(), &engine)
                .unwrap_err()
                .contains("SHA-256")
        );
    }

    #[test]
    fn stage_uses_actual_archive_manifest_and_rejects_bad_permissions_or_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("fixture.wbpkg");
        let defaults = serde_json::json!({
            "id": "com.example.fixture",
            "name": "合成模块",
            "version": "1.0.0",
            "minHostVersion": "0.1.0",
            "entry": "index.html",
            "permissions": ["storage"]
        });
        let write = |manifest: &serde_json::Value| {
            fs::write(
                &source,
                zip(&[
                    ("manifest.json", &serde_json::to_vec(manifest).unwrap()),
                    ("index.html", b"<p>fixture</p>"),
                    ("engine.exe", b"synthetic engine"),
                ]),
            )
            .unwrap();
        };
        let mut invalid = defaults.clone();
        invalid["permissions"] = serde_json::json!(["unknown"]);
        write(&invalid);
        assert!(
            stage_package(&source, tmp.path(), "0.1.0")
                .err()
                .unwrap()
                .contains("未知")
        );
        let mut invalid = defaults.clone();
        invalid["engine"] =
            serde_json::json!({"path":"engine.exe","sha256":"0".repeat(64),"concurrency":1});
        write(&invalid);
        assert!(
            stage_package(&source, tmp.path(), "0.1.0")
                .err()
                .unwrap()
                .contains("SHA-256")
        );
        let mut invalid = defaults.clone();
        invalid["engine"] = serde_json::Value::Null;
        write(&invalid);
        assert!(stage_package(&source, tmp.path(), "0.1.0").is_err());
        write(&defaults);
        let staged = stage_package(&source, tmp.path(), "0.1.0").unwrap();
        assert_eq!(staged.manifest.id, "com.example.fixture");
        assert_eq!(
            fs::read(staged.dir.path().join("1.0.0/index.html")).unwrap(),
            b"<p>fixture</p>"
        );
    }
}
