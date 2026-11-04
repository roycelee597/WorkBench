fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["execute_batch"])),
    )
    .expect("生成应用权限清单失败");
}
