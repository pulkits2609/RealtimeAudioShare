use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::ipc::{Channel, Response};

const HEADER_SIZE: usize = 20;
const MAX_PAYLOAD: usize = 262_144;
const DELIVERY_CAPACITY: usize = 4;

#[derive(Default)]
struct Delivery {
    active: bool,
    generation: u32,
    next_id: u32,
    delivered: u64,
    dropped: u64,
    pending: HashSet<u32>,
}

impl Delivery {
    fn reset(&mut self) {
        self.active = false;
        self.generation = self.generation.wrapping_add(1);
        self.pending.clear();
    }

    fn reserve(&mut self) -> Option<(u32, u32)> {
        if !self.active {
            return None;
        }
        if self.pending.len() >= DELIVERY_CAPACITY {
            self.dropped += 1;
            return None;
        }
        self.next_id = self.next_id.wrapping_add(1);
        self.pending.insert(self.next_id);
        Some((self.generation, self.next_id))
    }
}

#[derive(Serialize)]
pub struct CaptureStats {
    delivered: u64,
    dropped: u64,
    pending: usize,
    capacity: usize,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    input: Option<ChildStdin>,
    process_generation: u64,
    page_generation: u64,
    request_id: u32,
    requests: HashMap<u32, mpsc::SyncSender<Result<Value, String>>>,
    delivery: Delivery,
    audio: Option<Channel<Response>>,
    errors: Option<Channel<String>>,
}

#[derive(Clone, Default)]
pub struct NativeCapture {
    inner: Arc<Mutex<Inner>>,
    operation: Arc<Mutex<()>>,
}

impl NativeCapture {
    pub fn subscribe(&self, audio: Channel<Response>, errors: Channel<String>) {
        // Replacing a page's subscribers also tears down any earlier capture process.
        self.clear_subscribers();
        let mut inner = self.inner.lock().unwrap();
        inner.audio = Some(audio);
        inner.errors = Some(errors);
    }

    pub fn close(&self) {
        let mut inner = self.inner.lock().unwrap();
        close_inner(&mut inner, "Native capture closed.");
    }

    pub fn clear_subscribers(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.page_generation = inner.page_generation.wrapping_add(1);
        close_inner(&mut inner, "Native capture closed.");
        inner.audio = None;
        inner.errors = None;
    }

    pub fn page_generation(&self) -> u64 {
        self.inner.lock().unwrap().page_generation
    }

    pub fn stats(&self) -> CaptureStats {
        let inner = self.inner.lock().unwrap();
        CaptureStats {
            delivered: inner.delivery.delivered,
            dropped: inner.delivery.dropped,
            pending: inner.delivery.pending.len(),
            capacity: DELIVERY_CAPACITY,
        }
    }

    pub fn acknowledge(&self, generation: u32, frame_id: u32) {
        let mut inner = self.inner.lock().unwrap();
        if inner.delivery.generation == generation {
            inner.delivery.pending.remove(&frame_id);
        }
    }

    pub fn request(&self, helper: PathBuf, command: &str, value: Value) -> Result<Value, String> {
        self.request_for_page(helper, command, value, None)
    }

    fn request_for_page(
        &self,
        helper: PathBuf,
        command: &str,
        mut value: Value,
        page: Option<u64>,
    ) -> Result<Value, String> {
        if !cfg!(windows) {
            return Err("Native output-device capture is currently supported on Windows only. Use browser screen/audio sharing on this platform.".into());
        }
        let receiver = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Native capture state is unavailable.")?;
            if page.is_some_and(|generation| generation != inner.page_generation) {
                return Err(
                    "Capture request was cancelled because the AudioShare page changed.".into(),
                );
            }
            if inner.requests.len() >= 32 {
                return Err("Native capture command queue is full.".into());
            }
            if inner.child.is_none() {
                start_helper(&self.inner, &mut inner, helper)?;
            }
            inner.request_id = inner.request_id.wrapping_add(1).max(1);
            let id = inner.request_id;
            value["command"] = json!(command);
            value["requestId"] = json!(id);
            let (send, receive) = mpsc::sync_channel(1);
            inner.requests.insert(id, send);
            let bytes = format!("{}\n", value);
            if let Err(error) = inner.input.as_mut().unwrap().write_all(bytes.as_bytes()) {
                let message = format!("Could not send the native capture command: {error}");
                close_inner(&mut inner, &message);
                return Err(message);
            }
            receive
        };
        match receiver.recv_timeout(Duration::from_secs(10)) {
            Ok(result) => result,
            Err(_) => {
                self.close();
                Err("Native capture did not respond within 10 seconds. Refresh devices and try again.".into())
            }
        }
    }

    pub fn start(
        &self,
        helper: PathBuf,
        device_id: String,
        mode: String,
        page: u64,
    ) -> Result<Value, String> {
        if !matches!(mode.as_str(), "endpoint" | "exclude-self") {
            return Err("Choose a valid capture mode.".into());
        }
        if mode == "endpoint" && (device_id.is_empty() || device_id.len() > 2048) {
            return Err("Choose a valid output device.".into());
        }
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "Native capture operation is unavailable.")?;
        self.inner.lock().unwrap().delivery.reset();
        let mut response = self.request_for_page(
            helper,
            "start",
            json!({
                "deviceId": if mode == "endpoint" { device_id } else { String::new() },
                "mode": mode,
                // The renderer never chooses an arbitrary process to exclude.
                "targetProcessId": std::process::id(),
            }),
            Some(page),
        )?;
        let mut inner = self.inner.lock().unwrap();
        if inner.page_generation != page || inner.child.is_none() {
            return Err(
                "Capture request was cancelled because the AudioShare page changed.".into(),
            );
        }
        inner.delivery.active = true;
        response["generation"] = json!(inner.delivery.generation);
        Ok(response)
    }

    pub fn stop(&self, helper: PathBuf) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "Native capture operation is unavailable.")?;
        let has_child = {
            let mut inner = self.inner.lock().unwrap();
            inner.delivery.reset();
            inner.child.is_some()
        };
        if has_child {
            self.request(helper, "stop", json!({}))?;
        }
        Ok(())
    }
}

fn close_inner(inner: &mut Inner, reason: &str) {
    inner.process_generation = inner.process_generation.wrapping_add(1);
    inner.delivery.reset();
    inner.input.take();
    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    for (_, pending) in inner.requests.drain() {
        let _ = pending.send(Err(reason.into()));
    }
}

fn start_helper(
    state: &Arc<Mutex<Inner>>,
    inner: &mut Inner,
    helper: PathBuf,
) -> Result<(), String> {
    if !helper.is_file() {
        return Err("The native capture helper is missing. Run npm run build:native and rebuild AudioShare.".into());
    }
    let mut command = Command::new(helper);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Native capture could not start: {error}"))?;
    let mut output = child.stdout.take().unwrap();
    inner.input = child.stdin.take();
    inner.child = Some(child);
    inner.process_generation = inner.process_generation.wrapping_add(1);
    let process_generation = inner.process_generation;
    let state = Arc::clone(state);
    std::thread::Builder::new()
        .name("audioshare-capture-reader".into())
        .spawn(move || {
            let result = (|| -> Result<(), String> {
                loop {
                    let frame = read_packet(&mut output)?;
                    let mut inner = state
                        .lock()
                        .map_err(|_| "Native capture state is unavailable.")?;
                    if inner.process_generation != process_generation {
                        return Ok(());
                    }
                    match frame {
                        Packet::Audio {
                            samples,
                            sample_rate,
                            channels,
                        } => {
                            let Some((generation, frame_id)) = inner.delivery.reserve() else {
                                continue;
                            };
                            let mut packet = Vec::with_capacity(16 + samples.len());
                            packet.extend_from_slice(&generation.to_le_bytes());
                            packet.extend_from_slice(&frame_id.to_le_bytes());
                            packet.extend_from_slice(&sample_rate.to_le_bytes());
                            packet.extend_from_slice(&channels.to_le_bytes());
                            packet.extend_from_slice(&samples);
                            let sent = inner
                                .audio
                                .as_ref()
                                .is_some_and(|channel| channel.send(Response::new(packet)).is_ok());
                            if sent {
                                inner.delivery.delivered += 1;
                            } else {
                                inner.delivery.pending.remove(&frame_id);
                                inner.delivery.dropped += 1;
                            }
                        }
                        Packet::Control(value) => {
                            let id =
                                value.get("requestId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let is_error = value["type"] == "error";
                            let message = value["message"]
                                .as_str()
                                .unwrap_or("Native capture failed.")
                                .to_string();
                            if let Some(pending) = inner.requests.remove(&id) {
                                let _ =
                                    pending.send(if is_error { Err(message) } else { Ok(value) });
                            } else if is_error {
                                inner.delivery.reset();
                                if let Some(errors) = inner.errors.as_ref() {
                                    let _ = errors.send(message);
                                }
                            }
                        }
                    }
                }
            })();
            if let Err(error) = result {
                if let Ok(mut inner) = state.lock() {
                    if inner.process_generation != process_generation {
                        return;
                    }
                    let errors = inner.errors.clone();
                    close_inner(&mut inner, &error);
                    if let Some(errors) = errors {
                        let _ = errors.send(error);
                    }
                }
            }
        })
        .map_err(|error| format!("Could not start the native reader: {error}"))?;
    Ok(())
}

#[derive(Debug)]
enum Packet {
    Audio {
        samples: Vec<u8>,
        sample_rate: u32,
        channels: u32,
    },
    Control(Value),
}

fn read_packet(reader: &mut impl Read) -> Result<Packet, String> {
    let mut header = [0u8; HEADER_SIZE];
    reader
        .read_exact(&mut header)
        .map_err(|_| "Native capture exited or its audio pipe closed.".to_string())?;
    let read_u32 = |offset| u32::from_le_bytes(header[offset..offset + 4].try_into().unwrap());
    let kind = read_u32(4);
    let length = read_u32(8) as usize;
    if &header[..4] != b"ASB1" || !matches!(kind, 1 | 2) || length > MAX_PAYLOAD {
        return Err("Native capture returned an invalid packet.".into());
    }
    let mut payload = vec![0; length];
    reader
        .read_exact(&mut payload)
        .map_err(|_| "Native capture returned an incomplete packet.".to_string())?;
    if kind == 1 {
        let sample_rate = read_u32(12);
        let channels = read_u32(16);
        if !(1..=8).contains(&channels)
            || !(8000..=192000).contains(&sample_rate)
            || length == 0
            || length % (channels as usize * 4) != 0
        {
            return Err("Native capture returned invalid audio metadata.".into());
        }
        Ok(Packet::Audio {
            samples: payload,
            sample_rate,
            channels,
        })
    } else {
        let value: Value = serde_json::from_slice(&payload)
            .map_err(|_| "Native capture returned invalid control data.".to_string())?;
        if !value.is_object() || !value["type"].is_string() || value["type"] == "audio" {
            return Err("Native capture returned invalid control data.".into());
        }
        Ok(Packet::Control(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet(kind: u32, rate: u32, channels: u32, payload: &[u8]) -> Vec<u8> {
        let mut data = b"ASB1".to_vec();
        for number in [kind, payload.len() as u32, rate, channels] {
            data.extend(number.to_le_bytes());
        }
        data.extend(payload);
        data
    }
    #[test]
    fn reads_binary_pcm_without_sample_json() {
        let data = packet(1, 48000, 2, &[0; 16]);
        assert!(matches!(
            read_packet(&mut data.as_slice()),
            Ok(Packet::Audio {
                sample_rate: 48000,
                channels: 2,
                ..
            })
        ));
    }
    #[test]
    fn validates_headers_and_audio_alignment() {
        assert!(read_packet(&mut packet(1, 48000, 2, &[0; 7]).as_slice()).is_err());
        assert!(read_packet(&mut packet(1, 48000, 0, &[0; 8]).as_slice()).is_err());
        assert!(read_packet(&mut packet(3, 48000, 2, &[0; 8]).as_slice()).is_err());
        assert!(read_packet(&mut packet(2, 0, 0, br#"{"type":"audio"}"#).as_slice()).is_err());
        let mut oversized = packet(2, 0, 0, &[]);
        oversized[8..12].copy_from_slice(&(MAX_PAYLOAD as u32 + 1).to_le_bytes());
        assert!(read_packet(&mut oversized.as_slice()).is_err());
    }
    #[test]
    fn reads_control_messages() {
        let data = packet(2, 0, 0, br#"{"type":"devices","requestId":1,"devices":[]}"#);
        assert!(
            matches!(read_packet(&mut data.as_slice()), Ok(Packet::Control(value)) if value["requestId"] == 1)
        );
    }
    #[test]
    fn bounds_inflight_audio_and_invalidates_stopped_generations() {
        let mut delivery = Delivery {
            active: true,
            ..Delivery::default()
        };
        for _ in 0..4 {
            assert!(delivery.reserve().is_some());
        }
        assert!(delivery.reserve().is_none());
        assert_eq!(delivery.dropped, 1);
        let generation = delivery.generation;
        delivery.reset();
        assert_ne!(generation, delivery.generation);
        assert!(delivery.pending.is_empty());
        assert!(delivery.reserve().is_none());
    }

    #[test]
    fn stale_page_cannot_start_capture_and_stale_ack_cannot_free_new_capacity() {
        let capture = NativeCapture::default();
        let page = capture.page_generation();
        capture.clear_subscribers();
        let error = capture
            .start(
                PathBuf::from("missing-helper.exe"),
                "device".into(),
                "endpoint".into(),
                page,
            )
            .unwrap_err();
        assert!(error.contains("page changed"));
        assert!(capture.inner.lock().unwrap().child.is_none());
        {
            let mut inner = capture.inner.lock().unwrap();
            inner.delivery.active = true;
            inner.delivery.generation = 4;
            inner.delivery.pending.insert(10);
        }
        capture.acknowledge(3, 10);
        assert_eq!(capture.stats().pending, 1);
        capture.acknowledge(4, 10);
        assert_eq!(capture.stats().pending, 0);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires a source-built Windows WASAPI helper; enumerates endpoints but records no audio"]
    fn native_helper_enumerates_devices_and_restarts_after_close() {
        let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/native/AudioShare.Capture.exe");
        assert!(helper.is_file(), "Run the native build script first");
        let capture = NativeCapture::default();
        let devices = capture
            .request(helper.clone(), "devices", json!({}))
            .unwrap();
        assert!(devices["devices"].is_array());
        let capabilities = capture
            .request(helper.clone(), "capabilities", json!({}))
            .unwrap();
        assert!(capabilities["processExclusion"].is_boolean());
        capture.close();
        assert!(capture.inner.lock().unwrap().child.is_none());
        assert!(capture.request(helper, "devices", json!({})).is_ok());
        capture.close();
        assert!(capture.inner.lock().unwrap().requests.is_empty());
    }
}
