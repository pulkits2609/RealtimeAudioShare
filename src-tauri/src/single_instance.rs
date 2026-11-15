// A shared WebView2 profile can reuse a browser/audio process between app hosts.
// Keep one host per login session so excluding our host's process tree remains well-defined.
#[cfg(windows)]
pub struct SingleInstance(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl SingleInstance {
    pub fn acquire() -> Result<Option<Self>, String> {
        Self::claim_name("Local\\AudioShare.Tauri.com.audioshare.desktop")
    }

    fn claim_name(name: &str) -> Result<Option<Self>, String> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS},
            System::Threading::CreateMutexW,
        };
        let name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err("Could not establish the AudioShare single-instance guard.".into());
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                CloseHandle(handle);
            }
            return Ok(None);
        }
        Ok(Some(Self(handle)))
    }
}

#[cfg(windows)]
impl Drop for SingleInstance {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
pub fn show_startup_notice(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK};
    let title: Vec<u16> = "AudioShare\0".encode_utf16().collect();
    let message: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONINFORMATION,
        );
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn guard_rejects_second_host_and_releases_when_first_closes() {
        let name = format!("Local\\AudioShare.test.{}", std::process::id());
        let first = SingleInstance::claim_name(&name).unwrap().unwrap();
        assert!(SingleInstance::claim_name(&name).unwrap().is_none());
        drop(first);
        assert!(SingleInstance::claim_name(&name).unwrap().is_some());
    }
}
