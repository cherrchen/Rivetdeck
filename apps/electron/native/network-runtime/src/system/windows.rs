//! Current-user WinHTTP policy with ordered native PAC results and no static fallback.
use super::{Options, POLICY_ERROR, Route, Snapshot, UNAVAILABLE};
use std::{
    ffi::c_void,
    ptr,
    sync::{OnceLock, mpsc},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{ERROR_IO_PENDING, GlobalFree},
    Networking::WinHttp::*,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
unsafe fn text(ptr: *const u16) -> Result<String, &'static str> {
    if ptr.is_null() {
        return Ok(String::new());
    }
    let mut length = 0;
    while length < 32 * 1024 {
        if unsafe { *ptr.add(length) } == 0 {
            return String::from_utf16(unsafe { std::slice::from_raw_parts(ptr, length) })
                .map_err(|_| POLICY_ERROR);
        }
        length += 1;
    }
    Err(POLICY_ERROR)
}
struct Settings(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG);
impl Drop for Settings {
    fn drop(&mut self) {
        unsafe {
            for p in [
                self.0.lpszAutoConfigUrl,
                self.0.lpszProxy,
                self.0.lpszProxyBypass,
            ] {
                if !p.is_null() {
                    GlobalFree(p.cast());
                }
            }
        }
    }
}
struct Handle(*mut c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            WinHttpCloseHandle(self.0);
        }
    }
}
struct Results(WINHTTP_PROXY_RESULT);
impl Drop for Results {
    fn drop(&mut self) {
        unsafe {
            WinHttpFreeProxyResult(&mut self.0);
        }
    }
}
static COMPLETION: OnceLock<mpsc::Sender<bool>> = OnceLock::new();
unsafe extern "system" fn callback(_: *mut c_void, _: usize, status: u32, _: *mut c_void, _: u32) {
    if let Some(sender) = COMPLETION.get() {
        if status == WINHTTP_CALLBACK_STATUS_GETPROXYFORURL_COMPLETE {
            let _ = sender.send(true);
        } else if status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR {
            let _ = sender.send(false);
        }
    }
}
fn automatic(
    url: &url::Url,
    pac: &str,
    detect: bool,
    options: Options,
) -> Result<Vec<Route>, &'static str> {
    unsafe {
        let agent = wide("DSH System Proxy Resolver");
        let session = Handle(WinHttpOpen(
            agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_NO_PROXY,
            ptr::null(),
            ptr::null(),
            WINHTTP_FLAG_ASYNC,
        ));
        if session.0.is_null() {
            return Err(POLICY_ERROR);
        }
        let timeout = options.resolve_timeout_ms as i32;
        if WinHttpSetTimeouts(session.0, timeout, timeout, timeout, timeout) == 0 {
            return Err(POLICY_ERROR);
        }
        let mut resolver = ptr::null_mut();
        if WinHttpCreateProxyResolver(session.0, &mut resolver) != 0 {
            return Err(POLICY_ERROR);
        }
        let resolver = Handle(resolver);
        let (sender, receiver) = mpsc::channel();
        COMPLETION.set(sender).map_err(|_| POLICY_ERROR)?;
        WinHttpSetStatusCallback(
            resolver.0,
            Some(callback),
            WINHTTP_CALLBACK_FLAG_GETPROXYFORURL_COMPLETE | WINHTTP_CALLBACK_FLAG_REQUEST_ERROR,
            0,
        );
        let pac_url = wide(pac);
        // WPAD failure is terminal even when a static or PAC URL policy also exists.
        let auto = WINHTTP_AUTOPROXY_OPTIONS {
            dwFlags: if detect {
                WINHTTP_AUTOPROXY_AUTO_DETECT
            } else {
                WINHTTP_AUTOPROXY_CONFIG_URL
            },
            dwAutoDetectFlags: if detect {
                WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A
            } else {
                0
            },
            lpszAutoConfigUrl: if detect {
                ptr::null()
            } else {
                pac_url.as_ptr()
            },
            fAutoLogonIfChallenged: 0,
            ..Default::default()
        };
        let target = wide(url.as_str());
        let result = WinHttpGetProxyForUrlEx(resolver.0, target.as_ptr(), &auto, 0);
        if result != ERROR_IO_PENDING && result != 0 {
            return Err(POLICY_ERROR);
        }
        if receiver
            .recv_timeout(Duration::from_millis(options.resolve_timeout_ms))
            .ok()
            != Some(true)
        {
            return Err(POLICY_ERROR);
        }
        let mut results = Results(WINHTTP_PROXY_RESULT::default());
        if WinHttpGetProxyResult(resolver.0, &mut results.0) != 0
            || results.0.cEntries == 0
            || results.0.cEntries > 64
            || results.0.pEntries.is_null()
        {
            return Err(POLICY_ERROR);
        }
        let mut routes = Vec::new();
        for entry in std::slice::from_raw_parts(results.0.pEntries, results.0.cEntries as usize) {
            if entry.fProxy == 0 || entry.fBypass != 0 {
                routes.push(Route::Direct);
                continue;
            }
            let kind = match entry.ProxyScheme {
                WINHTTP_INTERNET_SCHEME_HTTP => "HTTP",
                WINHTTP_INTERNET_SCHEME_HTTPS => "HTTPS",
                WINHTTP_INTERNET_SCHEME_SOCKS => "SOCKS5",
                _ => return Err(POLICY_ERROR),
            };
            routes.push(super::endpoint(
                kind,
                &crate::connector::authority(&text(entry.pwszProxy)?, entry.ProxyPort),
            )?);
        }
        Ok(routes)
    }
}
pub fn query(url: Option<&url::Url>, options: Options) -> Result<Snapshot, &'static str> {
    let mut settings = Settings(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default());
    if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut settings.0) } == 0 {
        return Err(UNAVAILABLE);
    }
    let proxy = unsafe { text(settings.0.lpszProxy)? };
    let bypass = unsafe { text(settings.0.lpszProxyBypass)? };
    let pac = unsafe { text(settings.0.lpszAutoConfigUrl)? };
    let detect = settings.0.fAutoDetect != 0;
    let source = if detect {
        "wpad"
    } else if !pac.is_empty() {
        "pac"
    } else if !proxy.is_empty() {
        "manual"
    } else {
        "none"
    };
    let snapshot = Snapshot::new(
        "windows-winhttp",
        source,
        serde_json::to_vec(&(detect, &pac, &proxy, &bypass)).unwrap(),
    );
    let Some(url) = url else {
        return Ok(snapshot);
    };
    let routes = if detect || !pac.is_empty() {
        automatic(url, &pac, detect, options)?
    } else if proxy.is_empty() {
        vec![Route::Direct]
    } else {
        let mode = proxy_watch::parse::windows_manual(&proxy, &bypass);
        if mode.rejected().is_some_and(|r| !r.is_empty()) {
            return Err(POLICY_ERROR);
        }
        if let proxy_watch::ProxyMode::Manual { bypass, .. } = &mode {
            if !bypass.rejected.is_empty() {
                return Err(POLICY_ERROR);
            }
        }
        let config =
            proxy_watch::ProxyConfig::from_source(proxy_watch::ProxyConfigSource::Registry, mode);
        proxy_watch::resolve(&config, url)
            .map_err(|_| POLICY_ERROR)?
            .iter()
            .map(super::step_route)
            .collect::<Result<Vec<_>, _>>()?
    };
    snapshot.select(routes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };

    #[test]
    fn native_winhttp_pac_keeps_proxy_order_and_intentional_direct() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "WinHTTP did not fetch PAC"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            // Accepted Windows sockets inherit the listener's nonblocking mode.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut buffer = [0; 4096];
            stream.read(&mut buffer).unwrap();
            let body = "function FindProxyForURL(url, host) { return 'PROXY first.example:8080; PROXY second.example:8081; DIRECT'; }";
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/x-ns-proxy-autoconfig\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let routes = automatic(
            &url::Url::parse("http://outside.invalid/").unwrap(),
            &format!("http://{address}/proxy.pac"),
            false,
            Options::default(),
        );
        server.join().unwrap();
        assert_eq!(
            routes.unwrap(),
            vec![
                Route::Http {
                    host: "first.example".into(),
                    port: 8080
                },
                Route::Http {
                    host: "second.example".into(),
                    port: 8081
                },
                Route::Direct
            ]
        );
    }
}
