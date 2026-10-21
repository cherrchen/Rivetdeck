//! Actual executable protocol and shutdown regression coverage.
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread::{self, JoinHandle},
    time::Duration,
};

struct Runtime {
    child: Child,
    input: Option<ChildStdin>,
    frames: Receiver<String>,
    reader: Option<JoinHandle<()>>,
    errors: Option<JoinHandle<String>>,
}
impl Runtime {
    fn new() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_dsh-electron-network-runtime"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (sender, frames) = mpsc::channel();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        let errors = thread::spawn(move || {
            let mut text = String::new();
            stderr.read_to_string(&mut text).unwrap();
            text
        });
        Self {
            child,
            input,
            frames,
            reader: Some(reader),
            errors: Some(errors),
        }
    }
    fn send(&mut self, value: Value) {
        writeln!(self.input.as_mut().unwrap(), "{value}").unwrap();
    }
    fn next(&self) -> Value {
        serde_json::from_str(
            &self
                .frames
                .recv_timeout(Duration::from_secs(10))
                .expect("runtime response deadline"),
        )
        .unwrap()
    }
    fn call(&mut self, command: &str, payload: Value) -> Value {
        self.send(json!({"v":2,"id":command,"type":command,"payload":payload}));
        loop {
            let value = self.next();
            if value.get("id").is_some() {
                assert_eq!(value["id"], command);
                return value;
            }
        }
    }
    fn hello(&mut self) -> u16 {
        let value = self.call("hello", json!({}));
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"]["gateway"]["host"], "127.0.0.1");
        let port = value["result"]["gateway"]["port"].as_u64().unwrap();
        assert!((1..=65535).contains(&port));
        let updater_port = value["result"]["updaterGateway"]["port"].as_u64().unwrap();
        assert!((1..=65535).contains(&updater_port));
        assert_ne!(port, updater_port);
        let mut normalized = value["result"].clone();
        normalized["gateway"]["port"] = json!(0);
        normalized["updaterGateway"]["port"] = json!(0);
        let recorded = match normalized["systemBackend"].as_str().unwrap() {
            "macos-cfnetwork" => {
                include_str!("../../../tests/expected/network-runtime-hello-macos-cfnetwork.json")
            }
            "windows-winhttp" => {
                include_str!("../../../tests/expected/network-runtime-hello-windows-winhttp.json")
            }
            "linux-gnome" => {
                include_str!("../../../tests/expected/network-runtime-hello-linux-gnome.json")
            }
            "linux-kde" => {
                include_str!("../../../tests/expected/network-runtime-hello-linux-kde.json")
            }
            "unsupported" => include_str!("../../../tests/expected/network-runtime-hello.json"),
            other => panic!("unexpected backend: {other}"),
        };
        let expected: Value = serde_json::from_str(recorded).unwrap();
        assert_eq!(normalized, expected);
        port as u16
    }
    fn finish(&mut self) -> String {
        self.input.take();
        loop {
            match self.frames.recv_timeout(Duration::from_secs(10)) {
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => panic!("runtime stdout did not close"),
            }
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "runtime did not exit after stdout EOF"
            );
            thread::sleep(Duration::from_millis(5));
        };
        assert!(status.success());
        self.reader.take().unwrap().join().unwrap();
        self.errors.take().unwrap().join().unwrap()
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Some(errors) = self.errors.take() {
            let _ = errors.join();
        }
    }
}

#[test]
fn negotiation_malformed_input_and_secret_free_responses() {
    let mut runtime = Runtime::new();
    let port = runtime.hello();
    assert_eq!(
        runtime.call("get_diagnostics", json!({}))["result"]["configured"],
        false
    );
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .write_all(b"CONNECT localhost:80 HTTP/1.1\r\n\r\n")
        .unwrap();
    let mut bytes = [0];
    match stream.read(&mut bytes) {
        Ok(0) => {}
        Err(error) => assert!(
            matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
            ),
            "unconfigured Gateway closed the connection with {error}"
        ),
        _ => panic!("unconfigured Gateway did not close the connection"),
    }
    writeln!(runtime.input.as_mut().unwrap(), "{{MALFORMED TOP_SECRET").unwrap();
    assert_eq!(runtime.next()["payload"]["code"], "MALFORMED_FRAME");
    let result = runtime.call("configure", json!({"config":{"mode":"manual","strictFallback":true,"proxy":{"protocol":"http","host":"localhost","port":12345,"password":"TOP_SECRET"}}}));
    assert_eq!(result["ok"], true);
    assert!(!result.to_string().contains("TOP_SECRET"));
    assert_eq!(
        runtime.call("get_diagnostics", json!({}))["result"],
        json!({"configured":true,"system":null})
    );
    assert_eq!(
        runtime.call(
            "configure",
            json!({"config":{"mode":"direct","strictFallback":false}})
        )["ok"],
        false
    );
    assert_eq!(runtime.call("configure", json!({"config":{"mode":"manual","strictFallback":true,"proxy":{"protocol":"socks5","host":"localhost","port":1080,"password":"TOP_SECRET"}}}))["error"]["code"], "INVALID_CONFIG");
    assert_eq!(
        runtime.call("unknown_command", json!({"password":"TOP_SECRET"}))["error"]["code"],
        "UNSUPPORTED_COMMAND"
    );
    assert_eq!(
        runtime.call("get_diagnostics", json!({}))["result"]["configured"],
        true
    );
    assert_eq!(runtime.call("shutdown", json!({}))["ok"], true);
    assert!(!runtime.finish().contains("TOP_SECRET"));
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
}

#[test]
fn gateway_accepts_only_the_bound_loopback_address() {
    let mut runtime = Runtime::new();
    let port = runtime.hello();
    assert!(
        TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_secs(2),
        )
        .is_ok()
    );
    assert!(
        TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 2], port)),
            Duration::from_millis(500),
        )
        .is_err(),
        "gateway accepted 127.0.0.2"
    );
    runtime.finish();
}

#[test]
fn mixed_port_http_proxy_serves_requests_and_connect_without_a_second_route() {
    let mut runtime = Runtime::new();
    let gateway = runtime.hello();
    let proxy = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = proxy.local_addr().unwrap().port();
    let seen = thread::spawn(move || {
        let mut kinds = Vec::new();
        for _ in 0..2 {
            let (mut socket, _) = proxy.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = String::new();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
                request.push_str(&line);
            }
            kinds.push(request.lines().next().unwrap().to_string());
            socket
                .write_all(if request.starts_with("CONNECT ") {
                    b"HTTP/1.1 200 Connection Established\r\n\r\n"
                } else {
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                })
                .unwrap();
        }
        kinds
    });
    assert_eq!(
        runtime.call(
            "configure",
            json!({"config":{"mode":"manual","strictFallback":true,"proxy":{"protocol":"http","host":"127.0.0.1","port":port}}})
        )["ok"],
        true
    );
    for request in [
        format!(
            "GET http://remote-only.invalid/health HTTP/1.1\r\nHost: remote-only.invalid\r\nConnection: close\r\n\r\n"
        ),
        "CONNECT remote-only.invalid:443 HTTP/1.1\r\nHost: remote-only.invalid:443\r\n\r\n"
            .to_string(),
    ] {
        let mut client = TcpStream::connect(("127.0.0.1", gateway)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client.write_all(request.as_bytes()).unwrap();
        let mut status = String::new();
        BufReader::new(&client).read_line(&mut status).unwrap();
        assert!(
            status.starts_with("HTTP/1.1 204") || status.starts_with("HTTP/1.1 200"),
            "{status}"
        );
    }
    let kinds = seen.join().unwrap();
    assert_eq!(kinds.len(), 2);
    assert!(kinds[0].starts_with("GET http://remote-only.invalid/health "));
    assert!(kinds[1].starts_with("CONNECT remote-only.invalid:443 "));
    runtime.finish();
}

#[test]
fn mismatched_version_and_oversized_frame_close_runtime() {
    for oversize in [false, true] {
        let mut runtime = Runtime::new();
        runtime.hello();
        if oversize {
            runtime
                .input
                .as_mut()
                .unwrap()
                .write_all(&vec![b'x'; 1024 * 1024 + 1])
                .unwrap();
            assert_eq!(runtime.next()["event"], "runtime_warning");
        } else {
            runtime.send(json!({"v":3,"id":"mismatch","type":"hello","payload":{}}));
            assert_eq!(
                runtime.next()["error"]["code"],
                "NETWORK_RUNTIME_PROTOCOL_MISMATCH"
            );
        }
        runtime.finish();
    }
}

#[test]
fn shutdown_drains_then_closes_idle_tunnels_and_listener() {
    let mut runtime = Runtime::new();
    let port = runtime.hello();
    assert_eq!(runtime.call("configure", json!({"config":{"mode":"direct","strictFallback":true},"limits":{"connectTimeoutMs":1000,"headerTimeoutMs":1000,"shutdownTimeoutMs":20,"maxConnections":1}}))["ok"], true);
    let origin = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let target = origin.local_addr().unwrap();
    let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    write!(
        client,
        "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n"
    )
    .unwrap();
    let (mut upstream, _) = origin.accept().unwrap();
    upstream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut reader = BufReader::new(&client);
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    assert!(first.starts_with("HTTP/1.1 200"));
    assert_eq!(runtime.call("shutdown", json!({}))["ok"], true);
    runtime.finish();
    let mut rest = Vec::new();
    upstream.read_to_end(&mut rest).unwrap();
    assert!(rest.is_empty());
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
}

#[test]
fn process_crash_closes_managed_gateway_without_connecting_to_target() {
    let mut runtime = Runtime::new();
    let port = runtime.hello();
    let origin = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    origin.set_nonblocking(true).unwrap();
    assert_eq!(runtime.call("configure", json!({"config":{"mode":"manual","strictFallback":true,"proxy":{"protocol":"socks5","host":"127.0.0.1","port":origin.local_addr().unwrap().port()}}}))["ok"], true);
    runtime.child.kill().unwrap();
    assert!(!runtime.child.wait().unwrap().success());
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    assert_eq!(
        origin.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
#[cfg(target_os = "macos")]
fn native_system_snapshot_reload_and_shutdown() {
    let mut runtime = Runtime::new();
    runtime.hello();
    assert_eq!(
        runtime.call(
            "configure",
            json!({"config":{"mode":"system","strictFallback":true}})
        )["ok"],
        true
    );
    let first = runtime.call("get_system_snapshot", json!({}));
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["result"]["backend"], "macos-cfnetwork");
    assert_eq!(
        first["result"]["policyFingerprint"].as_str().unwrap().len(),
        64
    );
    assert_eq!(
        runtime.call("get_system_snapshot", json!({}))["result"],
        first["result"]
    );
    assert_eq!(
        runtime.call("reload_system", json!({}))["result"],
        first["result"]
    );
    assert_eq!(runtime.call("shutdown", json!({}))["ok"], true);
    runtime.finish();
}
