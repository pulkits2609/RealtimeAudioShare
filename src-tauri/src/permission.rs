use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct NativeMediaProtections(Arc<AtomicBool>);

impl Default for NativeMediaProtections {
    fn default() -> Self {
        Self(Arc::new(AtomicBool::new(!cfg!(windows))))
    }
}

impl NativeMediaProtections {
    pub fn is_ready(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    pub fn initialize(&self, registration: Result<(), String>) -> Result<(), String> {
        self.0.store(registration.is_ok(), Ordering::SeqCst);
        registration
    }

    pub fn disable(&self) {
        self.0.store(false, Ordering::SeqCst);
    }

    pub fn require_ready(&self) -> Result<(), String> {
        if self.is_ready() {
            Ok(())
        } else {
            Err("Native media protections could not initialize. Restart AudioShare after updating Microsoft Edge WebView2.".into())
        }
    }
}

#[derive(Default)]
struct Session {
    generation: u64,
    approved: bool,
}

#[derive(Clone, Copy)]
pub struct ApprovalRequest(u64);

/// Generation and approval are one state transition: OFF cannot be undone by a late dialog.
#[derive(Clone, Default)]
pub struct SessionPermission(Arc<Mutex<Session>>);

impl SessionPermission {
    pub fn is_approved(&self) -> bool {
        self.0.lock().unwrap().approved
    }

    pub fn begin_request(&self) -> ApprovalRequest {
        let mut session = self.0.lock().unwrap();
        session.generation = session.generation.wrapping_add(1);
        session.approved = false;
        ApprovalRequest(session.generation)
    }

    pub fn approve(&self, request: ApprovalRequest) -> bool {
        let mut session = self.0.lock().unwrap();
        if session.generation != request.0 {
            return false;
        }
        session.approved = true;
        true
    }

    pub fn revoke(&self) {
        let mut session = self.0.lock().unwrap();
        session.generation = session.generation.wrapping_add(1);
        session.approved = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn failed_hook_registration_cannot_enable_native_media() {
        let protections = NativeMediaProtections(Arc::new(AtomicBool::new(false)));
        assert!(protections.require_ready().is_err());
        assert!(protections
            .initialize(Err("PermissionRequested registration failed".into()))
            .is_err());
        assert!(protections.require_ready().is_err());
        assert!(protections
            .initialize(Err("ProcessFailed registration failed".into()))
            .is_err());
        assert!(!protections.is_ready());
        protections.initialize(Ok(())).unwrap();
        assert!(protections.require_ready().is_ok());
        protections.disable();
        assert!(protections.require_ready().is_err());
    }

    #[test]
    fn off_while_dialog_is_pending_cannot_be_reversed_by_late_approval() {
        let permission = SessionPermission::default();
        let request = permission.begin_request();
        let dialog_permission = permission.clone();
        let (ready_send, ready_receive) = mpsc::channel();
        let (continue_send, continue_receive) = mpsc::channel();
        let dialog = std::thread::spawn(move || {
            ready_send.send(()).unwrap();
            continue_receive.recv().unwrap();
            dialog_permission.approve(request)
        });
        ready_receive.recv().unwrap();
        permission.revoke(); // Deterministically interleave OFF before the dialog commits.
        continue_send.send(()).unwrap();
        assert!(!dialog.join().unwrap());
        assert!(!permission.is_approved());
    }

    #[test]
    fn revoke_after_approval_and_newer_requests_invalidate_older_authority() {
        let permission = SessionPermission::default();
        let first = permission.begin_request();
        assert!(permission.approve(first));
        permission.revoke();
        assert!(!permission.is_approved());
        assert!(!permission.approve(first));
        let second = permission.begin_request();
        let third = permission.begin_request();
        assert!(!permission.approve(second));
        assert!(permission.approve(third));
        assert!(permission.is_approved());
    }
}
