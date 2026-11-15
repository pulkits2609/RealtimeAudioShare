fn main() {
    // Also place resources next to an unbundled Windows executable.
    let helper = std::path::Path::new("resources/native/AudioShare.Capture.exe");
    println!("cargo:rerun-if-changed={}", helper.display());
    if helper.is_file() {
        let out_dir = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        let profile = out_dir.ancestors().nth(3).unwrap();
        let native = profile.join("native");
        std::fs::create_dir_all(&native).unwrap();
        std::fs::copy(helper, native.join("AudioShare.Capture.exe")).unwrap();
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "capture_subscribe",
            "capture_devices",
            "capture_capabilities",
            "capture_start",
            "capture_stop",
            "capture_stats",
            "capture_ack",
            "capture_close",
            "microphone_begin_session",
            "microphone_end_session",
        ]),
    ))
    .expect("could not build AudioShare desktop resources");
}
