use super::*;
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, atomic::AtomicU64},
    thread,
};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "workbench-ai-test-{}-{}-{}",
            std::process::id(),
            now(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn request() -> Value {
    json!({"model":"deepseek-flash","messages":[{"role":"user","content":"你好"}],"tools":[]})
}
fn tool() -> Value {
    json!({"type":"function","function":{"name":"calendar_list_events","description":"查询日程",
        "parameters":{"type":"object","properties":{},"additionalProperties":false}}})
}
fn response() -> Value {
    json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"你好"}}],
        "usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}})
}
fn normalized(value: Value) -> Result<ChatResponse> {
    normalize_response(&serde_json::to_vec(&value).unwrap())
}

#[test]
fn only_main_is_allowed_and_permissions_exclude_quick_create() {
    assert!(main_only("main").is_ok());
    for label in ["quick-create", "plugin", "", "Main"] {
        assert_eq!(main_only(label).unwrap_err().code, "FORBIDDEN");
    }
    let capability: Value =
        serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
    assert_eq!(capability["windows"], json!(["main"]));
    assert!(
        capability["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("allow-ai"))
    );
    assert!(!include_str!("../../capabilities/quick-create.json").contains("allow-ai"));
    let source = include_str!("../ai.rs");
    for command in [
        "ai_key_set",
        "ai_key_status",
        "ai_key_clear",
        "ai_key_test",
        "ai_chat",
        "ai_open_platform",
    ] {
        let section = source
            .split(&format!("fn {command}("))
            .nth(1)
            .unwrap()
            .split("#[tauri::command]")
            .next()
            .unwrap();
        assert!(section.contains("main_only(window.label())?"));
    }
}

#[test]
fn key_format_tail_and_debug_never_reveal_a_key() {
    let key = ApiKey::parse("  sk-fake-workbench-test-ab12  ").unwrap();
    let directory = Scratch::new();
    let mut usage = UsageStore::load(&directory.0, 1_794_646_800).unwrap();
    let state = key_status(Some(&key), usage.snapshot(1_794_646_800));
    let encoded = serde_json::to_string(&state).unwrap();
    assert!(state.configured);
    assert_eq!(state.tail.as_deref(), Some("ab12"));
    assert!(!encoded.contains(&key.0));
    assert!(!format!("{key:?}").contains(&key.0));
    assert!(!format!("{:?}", AiError::credential()).contains(&key.0));
    assert!(!key_status(None, usage.snapshot(1_794_646_800)).configured);
    for invalid in [
        "short",
        &"x".repeat(201),
        "sk-假密钥不允许测试字符串",
        "sk-fake-workbench\nsecret-key",
        "sk-fake-workbench secret-key",
    ] {
        assert_eq!(ApiKey::parse(invalid).unwrap_err().code, "KEY_FORMAT");
    }
}

#[test]
fn request_forces_options_and_only_forwards_allowed_fields() {
    let mut value = request();
    value["max_tokens"] = json!(999999);
    value["thinking"] = json!({"type":"enabled"});
    value["stream"] = json!(true);
    value["base_url"] = json!("https://invalid.example");
    value["authorization"] = json!("ignored-secret");
    let (model, bytes) = request_body(value).unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(model, "deepseek-flash");
    assert_eq!(body["max_tokens"], 800);
    assert_eq!(body["thinking"], json!({"type":"disabled"}));
    assert_eq!(body["stream"], false);
    assert!(body.get("tools").is_none());
    assert!(body.get("temperature").is_none());
    assert!(body.get("authorization").is_none());
    assert!(body.get("base_url").is_none());
}

#[test]
fn assistant_tool_calls_and_corresponding_tool_messages_round_trip() {
    let mut value = request();
    value["tools"] = json!([tool()]);
    value["messages"] = json!([
        {"role":"system","content":"只读"}, {"role":"user","content":"明天有什么安排"},
        {"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"calendar_list_events","arguments":"{}"}}]},
        {"role":"tool","tool_call_id":"call_1","content":"{\"type\":\"workbench_data\"}"}
    ]);
    let (_, bytes) = request_body(value).unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["messages"][2]["tool_calls"][0]["id"], "call_1");
    assert_eq!(body["messages"][3]["tool_call_id"], "call_1");
    assert_eq!(body["tool_choice"], "auto");
}

#[test]
fn models_roles_tools_and_limits_are_validated_before_sending() {
    for model in protocol::MODELS {
        let mut value = request();
        value["model"] = json!(model);
        assert!(request_body(value).is_ok());
    }
    let mut invalids = Vec::new();
    let mut value = request();
    value["model"] = json!("unknown");
    invalids.push(value);
    let mut value = request();
    value["messages"][0]["role"] = json!("developer");
    invalids.push(value);
    let mut value = request();
    value["messages"] = json!([{"role":"tool","content":"x"}]);
    invalids.push(value);
    let mut value = request();
    value["tools"] = json!([tool(), tool()]);
    invalids.push(value);
    let mut value = request();
    value["tools"] = json!([tool()]);
    value["tools"][0]["function"]["parameters"]["additionalProperties"] = json!(true);
    invalids.push(value);
    let mut value = request();
    value["messages"][0]["content"] = json!("中".repeat(8_001));
    invalids.push(value);
    let mut value = request();
    value["messages"] = json!(vec![json!({"role":"user","content":"x"}); 41]);
    invalids.push(value);
    let mut value = request();
    value["tools"] = json!(vec![tool(); 33]);
    invalids.push(value);
    let mut value = request();
    value["extra"] = json!("x".repeat(protocol::MAX_REQUEST));
    invalids.push(value);
    let mut value = request();
    value["messages"] = json!(vec![
        json!({"role":"user","content":"中".repeat(8_000)});
        6
    ]);
    invalids.push(value);
    for value in invalids {
        assert!(request_body(value).is_err());
    }
}

#[test]
fn normalize_text_tools_and_reject_truncated_or_malformed_responses() {
    assert_eq!(
        normalized(response()).unwrap().content.as_deref(),
        Some("你好")
    );
    let mut value = response();
    value["choices"][0]["finish_reason"] = json!("tool_calls");
    value["choices"][0]["message"]["content"] = Value::Null;
    value["choices"][0]["message"]["tool_calls"] = json!([{"id":"call_1","type":"function","function":{"name":"calendar_list_events","arguments":"{}"}}]);
    let parsed = normalized(value.clone()).unwrap();
    assert_eq!(parsed.tool_calls[0].name, "calendar_list_events");
    assert_eq!(parsed.usage.total_tokens, 16);
    value["choices"][0]["finish_reason"] = json!("length");
    assert_eq!(normalized(value).unwrap_err().code, "BAD_RESPONSE");
    for value in [
        json!({}),
        json!({"choices":[]}),
        json!({"choices":[{},{}]}),
        json!({"error":{"message":"do not echo"}}),
    ] {
        assert_eq!(normalized(value).unwrap_err().code, "BAD_RESPONSE");
    }
    let mut value = response();
    value["usage"]["prompt_tokens"] = json!(-1);
    assert!(normalized(value).is_err());
}

#[test]
fn loopback_only_in_debug_and_release_ignores_every_override() {
    for value in ["http://127.0.0.1:9999", "http://localhost:9999/"] {
        assert_eq!(base_url(Some(value), true).unwrap().scheme(), "http");
    }
    for value in [
        "https://localhost:9999",
        "http://localhost",
        "http://127.0.0.2:9999",
        "http://evil.example:9999",
        "http://localhost:9999/path",
        "http://localhost:9999?x=1",
        "http://localhost:9999#x",
        "http://user@localhost:9999",
        "not a url",
    ] {
        assert_eq!(
            base_url(Some(value), true).unwrap_err().code,
            "CONFIG_ERROR"
        );
        assert_eq!(
            base_url(Some(value), false).unwrap().as_str(),
            "https://api.deepseek.com/"
        );
    }
}

#[test]
fn single_flight_is_released_even_on_errors() {
    let state = AiState::default();
    let first = state.acquire().unwrap();
    assert!(matches!(state.acquire(), Err(AiError { code: "BUSY", .. })));
    drop(first);
    assert!(state.acquire().is_ok());
}

#[test]
fn http_status_maps_to_safe_local_errors() {
    for (status, code) in [
        (401, "KEY_INVALID"),
        (402, "INSUFFICIENT_BALANCE"),
        (429, "RATE_LIMITED"),
        (500, "UPSTREAM"),
        (503, "UPSTREAM"),
        (400, "BAD_RESPONSE"),
        (422, "BAD_RESPONSE"),
        (302, "BAD_RESPONSE"),
    ] {
        assert_eq!(http_error(status).code, code);
    }
}

#[test]
fn beijing_day_minute_limits_and_restart_recovery() {
    let directory = Scratch::new();
    // UTC 1970-01-01 15:59:59，北京时间 23:59:59。
    let time = 57_599;
    assert_eq!(usage::beijing_date(time), "1970-01-01");
    assert_eq!(usage::beijing_date(time + 1), "1970-01-02");
    assert_eq!(usage::beijing_date(951_840_000), "2000-03-01");
    let mut store = UsageStore::load(&directory.0, time).unwrap();
    for _ in 0..20 {
        store.charge(time).unwrap();
    }
    assert_eq!(store.charge(time).unwrap_err().code, "LOCAL_LIMIT");
    drop(store);
    let mut store = UsageStore::load(&directory.0, time).unwrap();
    assert_eq!(store.snapshot(time).calls, 20);
    assert!(store.charge(time).is_err());
    store.charge(time + 1).unwrap();
    assert_eq!(store.snapshot(time + 1).calls, 1);
    store.add_tokens(10, 5, time + 1).unwrap();
    drop(store);
    let mut store = UsageStore::load(&directory.0, time + 1).unwrap();
    assert_eq!(store.snapshot(time + 1).prompt_tokens, 10);
    for minute in 1..16 {
        for _ in 0..20 {
            if store.snapshot(time + 1 + minute * 60).calls < 300 {
                store.charge(time + 1 + minute * 60).unwrap();
            }
        }
    }
    assert_eq!(
        store.charge(time + 1 + 1000).unwrap_err().code,
        "LOCAL_LIMIT"
    );
    assert_eq!(store.snapshot(time - 60).calls, 300);
}

#[test]
fn corrupt_usage_recovers_conservatively_and_storage_failure_does_not_charge() {
    let directory = Scratch::new();
    fs::write(directory.0.join("ai-usage.json"), b"broken").unwrap();
    let mut store = UsageStore::load(&directory.0, 100_000).unwrap();
    assert_eq!(store.snapshot(100_000).calls, 150);
    assert!(
        fs::read_to_string(directory.0.join("ai-client.log"))
            .unwrap()
            .contains("usage_recovered")
    );
    drop(store);
    let mut store = UsageStore::load(&directory.0, 100_000).unwrap();
    assert_eq!(store.snapshot(100_000).calls, 150);
    fs::create_dir(directory.0.join("ai-usage.json.tmp")).unwrap();
    assert_eq!(store.charge(100_000).unwrap_err().code, "STORAGE_ERROR");
    assert_eq!(store.snapshot(100_000).calls, 150);
}

// 真实本机 TCP 服务验证传输，无需外网、真实凭据、额外测试依赖。
fn server(status: u16, body: String, delay: Duration) -> (Url, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let worker = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut received = Vec::new();
        loop {
            let mut buffer = [0u8; 4096];
            let len = stream.read(&mut buffer).unwrap();
            if len == 0 {
                break;
            }
            received.extend_from_slice(&buffer[..len]);
            if let Some(boundary) = received.windows(4).position(|b| b == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&received[..boundary]).to_lowercase();
                let size = header
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                if received.len() >= boundary + 4 + size {
                    break;
                }
            }
        }
        thread::sleep(delay);
        let _ = write!(
            stream,
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        String::from_utf8(received).unwrap()
    });
    (url, worker)
}

#[test]
fn mock_http_transport_auth_body_status_errors_and_failed_calls_count() {
    let directory = Scratch::new();
    let mut store = UsageStore::load(&directory.0, 100_000).unwrap();
    for status in [200, 401, 402, 429, 500, 503] {
        let (url, worker) = server(status, response().to_string(), Duration::ZERO);
        let client = client(&url, Duration::from_secs(2)).unwrap();
        let key = ApiKey::parse("sk-fake-workbench-test-ab12").unwrap();
        let (_, body) = request_body(request()).unwrap();
        let wire = build_request(
            &client,
            Method::POST,
            url.join("chat/completions").unwrap(),
            &key,
            Some(body),
        )
        .unwrap();
        assert!(!format!("{wire:?}").contains(&key.0));
        store.charge(100_000).unwrap();
        let (actual, _) = tauri::async_runtime::block_on(send(&client, wire)).unwrap();
        assert_eq!(actual, status);
        let raw = worker.join().unwrap();
        assert!(raw.starts_with("POST /chat/completions"));
        let body = raw.split("\r\n\r\n").nth(1).unwrap();
        assert!(!body.contains(&key.0));
        assert!(
            raw.to_lowercase()
                .contains(&format!("authorization: bearer {}", key.0))
        );
    }
    assert_eq!(store.snapshot(100_000).calls, 6);
    assert!(
        !fs::read_to_string(directory.0.join("ai-usage.json"))
            .unwrap()
            .contains("sk-fake")
    );
}

#[test]
fn timeout_network_failure_and_response_limit_do_not_retry() {
    let key = ApiKey::parse("sk-fake-workbench-test-ab12").unwrap();
    let (url, worker) = server(200, response().to_string(), Duration::from_millis(150));
    let client = client(&url, Duration::from_millis(40)).unwrap();
    let wire = build_request(&client, Method::GET, url.clone(), &key, None).unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(send(&client, wire))
            .unwrap_err()
            .code,
        "TIMEOUT"
    );
    worker.join().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let disconnected = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let closing = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0u8; 4096];
        let _ = stream.read(&mut buffer);
        // 收到请求后直接断开，不依赖 Windows 对未监听端口的超时策略。
    });
    let client = super::client(&disconnected, Duration::from_secs(2)).unwrap();
    let wire = build_request(&client, Method::GET, disconnected, &key, None).unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(send(&client, wire))
            .unwrap_err()
            .code,
        "NETWORK"
    );
    closing.join().unwrap();
    let (url, worker) = server(200, "x".repeat(MAX_RESPONSE + 1), Duration::ZERO);
    let client = super::client(&url, Duration::from_secs(2)).unwrap();
    let wire = build_request(&client, Method::GET, url, &key, None).unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(send(&client, wire))
            .unwrap_err()
            .code,
        "BAD_RESPONSE"
    );
    worker.join().unwrap();
}

#[test]
fn redirects_are_not_followed_and_local_failures_do_not_touch_usage() {
    let hits = Arc::new(AtomicU64::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let target = url.join("redirected").unwrap();
    let counted = hits.clone();
    let worker = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0u8; 4096];
        let _ = stream.read(&mut buffer);
        counted.fetch_add(1, Ordering::Relaxed);
        write!(stream,"HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    let client = client(&url, Duration::from_secs(2)).unwrap();
    let wire = build_request(
        &client,
        Method::GET,
        url,
        &ApiKey::parse("sk-fake-workbench-test-ab12").unwrap(),
        None,
    )
    .unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(send(&client, wire))
            .unwrap()
            .0,
        302
    );
    worker.join().unwrap();
    assert_eq!(hits.load(Ordering::Relaxed), 1);
    let directory = Scratch::new();
    let mut store = UsageStore::load(&directory.0, 100_000).unwrap();
    let mut bad = request();
    bad["model"] = json!("bad");
    assert!(request_body(bad).is_err());
    assert_eq!(store.snapshot(100_000).calls, 0);
    assert!(!directory.0.join("ai-usage.json").exists());
}
