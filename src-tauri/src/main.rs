#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod permission;
mod single_instance;

use capture::{CaptureStats, NativeCapture};
use permission::{NativeMediaProtections, SessionPermission};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{
    ipc::{Channel, Response},
    Manager, State, WebviewWindow,
};

#[derive(Clone, Default)]
struct DesktopState {
    capture: NativeCapture,
    microphone: SessionPermission,
    media_protections: NativeMediaProtections,
}

impl DesktopState {
    fn reset(&self) {
        self.microphone.revoke();
        self.capture.clear_subscribers();
    }
}

fn trusted_url(url: &tauri::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if !matches!(url.path(), "/" | "/index.html") {
        return false;
    }
    let production =
        url.scheme() == "http" && url.host_str() == Some("tauri.localhost") && url.port().is_none();
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    production || development
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main"
        || !trusted_url(
            &window
                .url()
                .map_err(|_| "Could not verify the AudioShare window.")?,
        )
    {
        return Err("Native audio is only available to the local AudioShare window.".into());
    }
    window
        .state::<DesktopState>()
        .media_protections
        .require_ready()
}

fn helper_path(window: &WebviewWindow) -> Result<PathBuf, String> {
    let resources = window
        .app_handle()
        .path()
        .resource_dir()
        .map_err(|_| "Could not locate AudioShare resources.")?;
    let helper = resources.join("native/AudioShare.Capture.exe");
    if helper.is_file() {
        return Ok(helper);
    }
    #[cfg(debug_assertions)]
    {
        let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/native/AudioShare.Capture.exe");
        if helper.is_file() {
            return Ok(helper);
        }
    }
    Err(
        "The native capture helper is missing. Run npm run build:native and rebuild AudioShare."
            .into(),
    )
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "The native audio operation could not finish.".to_string())?
}

#[tauri::command]
fn capture_subscribe(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    audio: Channel<Response>,
    errors: Channel<String>,
) -> Result<(), String> {
    require_main(&window)?;
    state.capture.subscribe(audio, errors);
    Ok(())
}

#[tauri::command]
async fn capture_devices(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<Value, String> {
    require_main(&window)?;
    let helper = helper_path(&window)?;
    let capture = state.capture.clone();
    blocking(move || capture.request(helper, "devices", json!({}))).await
}

#[tauri::command]
async fn capture_capabilities(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<Value, String> {
    require_main(&window)?;
    if !cfg!(windows) {
        return Ok(
            json!({"processExclusion": false, "reason": "Native WASAPI capture is only available on Windows."}),
        );
    }
    let helper = helper_path(&window)?;
    let capture = state.capture.clone();
    blocking(move || capture.request(helper, "capabilities", json!({}))).await
}

#[tauri::command]
async fn capture_start(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    device_id: String,
    mode: String,
) -> Result<Value, String> {
    require_main(&window)?;
    let helper = helper_path(&window)?;
    let capture = state.capture.clone();
    let page = capture.page_generation();
    blocking(move || capture.start(helper, device_id, mode, page)).await
}

#[tauri::command]
async fn capture_stop(window: WebviewWindow, state: State<'_, DesktopState>) -> Result<(), String> {
    require_main(&window)?;
    let helper = helper_path(&window)?;
    let capture = state.capture.clone();
    blocking(move || capture.stop(helper)).await
}

#[tauri::command]
fn capture_stats(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<CaptureStats, String> {
    require_main(&window)?;
    Ok(state.capture.stats())
}

#[tauri::command]
fn capture_ack(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    generation: u32,
    frame_id: u32,
) -> Result<(), String> {
    require_main(&window)?;
    state.capture.acknowledge(generation, frame_id);
    Ok(())
}

#[tauri::command]
fn capture_close(window: WebviewWindow, state: State<'_, DesktopState>) -> Result<(), String> {
    require_main(&window)?;
    state.reset();
    Ok(())
}

#[tauri::command]
async fn microphone_begin_session(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    device_id: Option<String>,
) -> Result<(), String> {
    require_main(&window)?;
    if device_id.as_ref().is_some_and(|id| id.len() > 2048) {
        return Err("Choose a valid microphone.".into());
    }
    if state.microphone.is_approved() {
        return Ok(());
    }
    let request = state.microphone.begin_request();
    let state = state.inner().clone();
    #[cfg(windows)]
    let owner = window
        .hwnd()
        .map_err(|_| "Could not open microphone consent.")?
        .0 as usize;
    blocking(move || {
        #[cfg(windows)]
        let approved = {
            use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONQUESTION, MB_YESNO};
            let title: Vec<u16> = "AudioShare microphone permission\0".encode_utf16().collect();
            let text: Vec<u16> = "Allow AudioShare to use your microphone for this room session?\n\nTurning the microphone off, leaving, or closing the window revokes this session. Windows microphone privacy settings still apply.\0".encode_utf16().collect();
            // Native explicit consent, with No as the default choice.
            unsafe { MessageBoxW(owner as _, text.as_ptr(), title.as_ptr(), MB_YESNO | MB_DEFBUTTON2 | MB_ICONQUESTION) == IDYES }
        };
        #[cfg(not(windows))]
        let approved = true; // Other platforms retain their WebView/OS media permission prompt.
        if !approved { return Err("Microphone permission was declined. You can enable it again when ready.".into()); }
        if !state.microphone.approve(request) {
            return Err("Microphone request was cancelled.".into());
        }
        Ok(())
    }).await
}

#[tauri::command]
fn microphone_end_session(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    require_main(&window)?;
    state.microphone.revoke();
    Ok(())
}

fn main() {
    #[cfg(windows)]
    let _single_instance = match single_instance::SingleInstance::acquire() {
        Ok(Some(guard)) => guard,
        Ok(None) => {
            single_instance::show_startup_notice(
                "AudioShare is already running. Switch to its existing window to continue.",
            );
            return;
        }
        Err(message) => {
            single_instance::show_startup_notice(&message);
            return;
        }
    };
    tauri::Builder::default()
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            capture_subscribe,
            capture_devices,
            capture_capabilities,
            capture_start,
            capture_stop,
            capture_stats,
            capture_ack,
            capture_close,
            microphone_begin_session,
            microphone_end_session
        ])
        .setup(|app| {
            let state = app.state::<DesktopState>().inner().clone();
            let navigation_state = state.clone();
            let permission_state = state.clone();
            let page_state = state.clone();
            let window =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .on_navigation(move |url| {
                        if trusted_url(url) {
                            return true;
                        }
                        navigation_state.reset();
                        false
                    })
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .on_page_load(move |_, payload| {
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                            page_state.reset();
                        }
                    })
                    .on_permission_request(move |_, kind| {
                        use tauri::webview::{PermissionKind, PermissionResponse};
                        // On Windows the checked COM handler below grants only AFTER
                        // disabling persistence. This first handler stays fail-closed.
                        if cfg!(windows) || !permission_state.media_protections.is_ready() {
                            return PermissionResponse::Deny;
                        }
                        match kind {
                            PermissionKind::Microphone
                                if permission_state.microphone.is_approved() =>
                            {
                                PermissionResponse::Allow
                            }
                            PermissionKind::Camera
                            | PermissionKind::Autoplay
                            | PermissionKind::ClipboardRead => PermissionResponse::Default,
                            _ => PermissionResponse::Deny,
                        }
                    })
                    .build()?;
            #[cfg(windows)]
            {
                let (registered_send, registered_receive) = std::sync::mpsc::sync_channel(1);
                let lifecycle_state = state.clone();
                let request_state = state.clone();
                window.with_webview(move |webview| {
                    // Stop native capture even if the WebView renderer crashes without unloading.
                    let registration = (|| -> Result<(), windows_core::Error> {
                        unsafe {
                            let core = webview.controller().CoreWebView2()?;
                            use webview2_com::Microsoft::Web::WebView2::Win32::{
                                ICoreWebView2PermissionRequestedEventArgs3,
                                COREWEBVIEW2_PERMISSION_KIND,
                                COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
                                COREWEBVIEW2_PERMISSION_KIND_CAMERA,
                                COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
                                COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                                COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                                COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
                                COREWEBVIEW2_PERMISSION_STATE_DENY,
                            };
                            use windows_core::Interface;
                            let mut permission_token = 0;
                            core.add_PermissionRequested(
                                &webview2_com::PermissionRequestedEventHandler::create(Box::new(
                                    move |_, args| {
                                        if let Some(args) = args {
                                            let decision = (|| -> Result<(), windows_core::Error> {
                                                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                                                // A failed persistence override must never leave an Allow.
                                                args.cast::<ICoreWebView2PermissionRequestedEventArgs3>()?.SetSavesInProfile(false)?;
                                                if !request_state.media_protections.is_ready() { return Ok(()); }
                                                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                                                args.PermissionKind(&mut kind)?;
                                                let response = match kind {
                                                    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE if request_state.microphone.is_approved() => COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                                                    COREWEBVIEW2_PERMISSION_KIND_CAMERA | COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY | COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
                                                    _ => COREWEBVIEW2_PERMISSION_STATE_DENY,
                                                };
                                                args.SetState(response)?;
                                                Ok(())
                                            })();
                                            if decision.is_err() {
                                                request_state.media_protections.disable();
                                                request_state.reset();
                                            }
                                            return decision;
                                        }
                                        Ok(())
                                    },
                                )),
                                &mut permission_token,
                            )?;
                            let mut token = 0;
                            core.add_ProcessFailed(
                                &webview2_com::ProcessFailedEventHandler::create(Box::new(
                                    move |_, _| {
                                        lifecycle_state.reset();
                                        Ok(())
                                    },
                                )),
                                &mut token,
                            )?;
                        }
                        Ok(())
                    })()
                    .map_err(|error| {
                        format!("Could not register native WebView2 media protections: {error}")
                    });
                    let _ = registered_send.send(registration);
                })?;
                // Setup runs on Tauri's main thread, where with_webview executes synchronously.
                // No native command or media permission is enabled until BOTH hooks are installed.
                let registration = registered_receive.try_recv().map_err(|error| {
                    std::io::Error::other(format!(
                        "Could not confirm native media protection setup: {error}"
                    ))
                })?;
                state
                    .media_protections
                    .initialize(registration)
                    .map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                )
            {
                window.state::<DesktopState>().reset();
            }
        })
        .run(tauri::generate_context!())
        .expect("could not start AudioShare");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn privileged_navigation_is_limited_to_local_main_document() {
        for url in [
            "https://example.com/",
            "http://tauri.localhost.evil/",
            "http://tauri.localhost/other",
            "http://user@tauri.localhost/",
            "http://localhost:9999/",
        ] {
            assert!(!trusted_url(&url.parse().unwrap()), "{url}");
        }
        assert!(trusted_url(&"http://tauri.localhost/".parse().unwrap()));
        assert!(trusted_url(
            &"http://tauri.localhost/index.html#meeting".parse().unwrap()
        ));
    }
}
