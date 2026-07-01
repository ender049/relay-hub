use base64::{engine::general_purpose, Engine as _};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{collections::HashSet, fs, path::PathBuf, sync::{atomic::{AtomicU64, Ordering}, mpsc, Mutex}, thread, time::{Duration, Instant}};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use url::Url;

const STORE_KEYS: &[&str] = &["apm_s", "apm_ch", "apm_tab", "apm_font", "relay_theme", "apm_ar"];
const OPEN_MODE_KEY: &str = "relay_open_mode";
const LEGACY_IDENTIFIER: &str = "works.earendil.relayhub";
const LOGIN_WINDOW_LABEL: &str = "channel-login";
static BROWSER_FETCH_SEQ: AtomicU64 = AtomicU64::new(1);

struct AppState {
    store: Mutex<Map<String, Value>>,
    client: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct FetchPayload {
    kind: Option<String>,
    url: String,
    method: Option<String>,
    headers: Option<Map<String, Value>>,
    body: Option<String>,
    #[serde(rename = "bodyBase64")]
    body_base64: Option<String>,
    #[serde(rename = "responseType")]
    response_type: Option<String>,
    #[serde(rename = "browserFetch")]
    browser_fetch: Option<bool>,
    #[serde(rename = "siteUrl")]
    site_url: Option<String>,
    #[serde(rename = "siteType")]
    site_type: Option<String>,
}

#[derive(Debug, Serialize)]
struct FetchResponse {
    ok: bool,
    status: u16,
    headers: Map<String, Value>,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct HostResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LoginPayload {
    #[serde(rename = "siteUrl")]
    site_url: String,
    #[serde(rename = "siteType")]
    site_type: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

#[derive(Debug, Serialize)]
struct TokenResponse {
    ok: bool,
    #[serde(rename = "siteUrl", skip_serializing_if = "Option::is_none")]
    site_url: Option<String>,
    #[serde(rename = "pageUrl", skip_serializing_if = "Option::is_none")]
    page_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cookie: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
    user_id_js: Option<String>,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    Ok(dir.join("store.json"))
}

fn legacy_store_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .data_dir()
        .ok()
        .map(|dir| dir.join(LEGACY_IDENTIFIER).join("store.json"))
}

fn migrate_legacy_store(app: &AppHandle, path: &PathBuf) {
    if path.exists() {
        return;
    }
    let Some(old_path) = legacy_store_path(app) else { return };
    if !old_path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::copy(old_path, path);
}

fn load_store(app: &AppHandle) -> Map<String, Value> {
    let Ok(path) = store_path(app) else { return Map::new() };
    migrate_legacy_store(app, &path);
    let Ok(raw) = fs::read_to_string(path) else { return Map::new() };
    serde_json::from_str::<Map<String, Value>>(&raw).unwrap_or_default()
}

fn save_store(app: &AppHandle, store: &Map<String, Value>) -> Result<(), String> {
    let path = store_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(path, serde_json::to_string_pretty(store).map_err(|err| err.to_string())?)
        .map_err(|err| err.to_string())
}

fn public_store(store: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for key in STORE_KEYS {
        if let Some(value) = store.get(*key) {
            out.insert((*key).to_string(), Value::String(value.as_str().unwrap_or_default().to_string()));
        }
    }
    out
}

fn emit_store(app: &AppHandle, store: &Map<String, Value>) {
    let _ = app.emit("relay-store-data", public_store(store));
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        #[cfg(windows)]
        let _ = window.set_skip_taskbar(false);
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(windows)]
        let _ = window.set_skip_taskbar(true);
        let _ = window.hide();
    }
}

fn start_minimize_watcher(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));
        let Some(window) = app.get_webview_window("main") else { continue };
        match window.is_minimized() {
            Ok(true) => hide_main_window(&app),
            Ok(false) => {}
            Err(_) => break,
        }
    });
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let icon = app.default_window_icon().cloned();
    let app_handle = app.handle().clone();
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Relay Hub")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(&app_handle);
            }
        });
    if let Some(icon) = icon {
        tray = tray.icon(icon);
    }
    let _tray = tray.build(app)?;
    Ok(())
}

fn emit_open_mode(app: &AppHandle, mode: &str) {
    let _ = app.emit("relay-open-mode-data", mode);
}

#[tauri::command]
fn relay_store_get(state: State<'_, AppState>) -> Map<String, Value> {
    let store = state.store.lock().expect("store mutex poisoned");
    public_store(&store)
}

#[tauri::command]
fn relay_store_set(app: AppHandle, state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    if !STORE_KEYS.contains(&key.as_str()) {
        return Ok(());
    }
    let mut store = state.store.lock().expect("store mutex poisoned");
    store.insert(key, Value::String(value));
    save_store(&app, &store)?;
    emit_store(&app, &store);
    Ok(())
}

#[tauri::command]
fn relay_open_mode_get(state: State<'_, AppState>) -> String {
    let store = state.store.lock().expect("store mutex poisoned");
    normalize_open_mode(store.get(OPEN_MODE_KEY).and_then(Value::as_str))
}

#[tauri::command]
fn relay_open_mode_set(app: AppHandle, state: State<'_, AppState>, mode: String) -> Result<String, String> {
    let next = normalize_open_mode(Some(&mode));
    let mut store = state.store.lock().expect("store mutex poisoned");
    store.insert(OPEN_MODE_KEY.to_string(), Value::String(next.clone()));
    save_store(&app, &store)?;
    emit_open_mode(&app, &next);
    Ok(next)
}

fn normalize_open_mode(value: Option<&str>) -> String {
    if value == Some("sidepanel") { "sidepanel".to_string() } else { "popup".to_string() }
}

#[tauri::command]
fn relay_open_sidepanel() -> HostResponse {
    HostResponse { ok: false, error: Some("客户端版使用单窗口布局".to_string()) }
}

#[tauri::command]
fn relay_copy_text(app: AppHandle, text: String) -> HostResponse {
    match app.clipboard().write_text(text) {
        Ok(_) => HostResponse { ok: true, error: None },
        Err(err) => HostResponse { ok: false, error: Some(err.to_string()) },
    }
}

#[tauri::command]
fn relay_open_external(url: String) -> Result<(), String> {
    if url.trim().is_empty() {
        return Ok(());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|err| err.to_string())
}

#[tauri::command]
async fn relay_open_site_login(app: AppHandle, payload: LoginPayload) -> HostResponse {
    match open_site_login_window(&app, payload).await {
        Ok(()) => HostResponse { ok: true, error: None },
        Err(error) => HostResponse { ok: false, error: Some(error) },
    }
}

#[tauri::command]
async fn relay_read_site_tokens(app: AppHandle, state: State<'_, AppState>, site_url: String, site_type: Option<String>) -> Result<TokenResponse, String> {
    let client = state.client.clone();
    Ok(match read_login_window_tokens(&app, &client, &site_url, site_type.as_deref()).await {
        Ok(response) => response,
        Err(error) => TokenResponse {
            ok: false,
            site_url: Some(site_url),
            page_url: None,
            source: None,
            error: Some(error),
            auth_token: None,
            access_token: None,
            refresh_token: None,
            cookie: None,
            token_expires_at: None,
            user_id: None,
            user_id_js: None,
        },
    })
}

#[tauri::command]
async fn relay_fetch(app: AppHandle, state: State<'_, AppState>, payload: FetchPayload) -> Result<FetchResponse, String> {
    Ok(match do_fetch(&app, &state.client, payload).await {
        Ok(response) => response,
        Err(error) => FetchResponse { ok: false, status: 0, headers: Map::new(), body: String::new(), error: Some(error) },
    })
}

fn login_url(site_url: &str, site_type: Option<&str>) -> Result<Url, String> {
    let mut url = Url::parse(site_url).map_err(|_| "请先填写有效的渠道站点地址".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("渠道站点地址需要使用 http 或 https".to_string());
    }
    let path = url.path().trim_end_matches('/').to_string();
    if path.is_empty() || path == "/" || path.starts_with("/api") {
        url.set_path("/login");
    }
    if site_type == Some("sub2api") && path.ends_with("/api/v1") {
        url.set_path("/login");
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

async fn open_site_login_window(app: &AppHandle, payload: LoginPayload) -> Result<(), String> {
    let url = login_url(&payload.site_url, payload.site_type.as_deref())?;
    let autofill = autofill_script(payload.username.as_deref().unwrap_or_default(), payload.password.as_deref().unwrap_or_default());
    let window = ensure_login_window(app, true)?;
    window.navigate(url).map_err(|err| err.to_string())?;
    schedule_autofill(window, autofill);
    Ok(())
}

fn ensure_login_window(app: &AppHandle, visible: bool) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        if visible {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(app, LOGIN_WINDOW_LABEL, WebviewUrl::App("login-loading.html".into()))
        .title("Relay Hub 登录接管")
        .inner_size(980.0, 760.0)
        .min_inner_size(520.0, 560.0)
        .resizable(true)
        .center()
        .visible(visible)
        .focused(visible)
        .build()
        .map_err(|err| err.to_string())?;
    keep_login_window_alive(&window);
    if visible {
        let _ = window.set_focus();
    }
    Ok(window)
}

fn keep_login_window_alive(window: &tauri::WebviewWindow) {
    let login = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = login.hide();
        }
    });
}

fn schedule_autofill(window: tauri::WebviewWindow, script: String) {
    thread::spawn(move || {
        for delay in [250_u64, 700, 1400, 2400, 3600] {
            thread::sleep(Duration::from_millis(delay));
            let _ = window.eval(script.clone());
        }
    });
}

fn autofill_script(username: &str, password: &str) -> String {
    format!(
        r#"(() => {{
  const username = {username};
  const password = {password};
  const visible = el => !!(el && el.offsetParent !== null && !el.disabled && !el.readOnly);
  const setValue = (el, value) => {{
    if (!el || !value) return false;
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
    return true;
  }};
  const findUser = () => Array.from(document.querySelectorAll('input')).find(el => visible(el) && /^(email|text|tel|search)$/i.test(el.type || 'text') && /(user|email|mail|account|login|name|账号|邮箱|用户名)/i.test(`${{el.name}} ${{el.id}} ${{el.placeholder}} ${{el.autocomplete}}`)) || Array.from(document.querySelectorAll('input')).find(el => visible(el) && /^(email|text)$/i.test(el.type || 'text'));
  const findPass = () => Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
  let tries = 0;
  let timer = null;
  const fill = () => {{
    tries += 1;
    const okUser = setValue(findUser(), username) || !username;
    const okPass = setValue(findPass(), password) || !password;
    if (((okUser && okPass) || tries >= 20) && timer) clearInterval(timer);
  }};
  fill();
  timer = setInterval(fill, 400);
}})();"#,
        username = serde_json::to_string(username).unwrap_or_else(|_| "\"\"".to_string()),
        password = serde_json::to_string(password).unwrap_or_else(|_| "\"\"".to_string()),
    )
}

async fn read_login_window_tokens(app: &AppHandle, client: &reqwest::Client, site_url: &str, site_type: Option<&str>) -> Result<TokenResponse, String> {
    let expected = Url::parse(site_url).map_err(|_| "请先填写有效的渠道站点地址".to_string())?;
    let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) else {
        return Err("请先点击“打开登录窗口”，完成 Turnstile 和登录后再读取令牌".to_string());
    };
    let current = window.url().map_err(|err| err.to_string())?;
    if !site_hosts_match(current.host_str().unwrap_or_default(), expected.host_str().unwrap_or_default()) {
        return Err(format!("登录窗口域名 {} 与渠道站点 {} 不匹配", current.host_str().unwrap_or_default(), expected.host_str().unwrap_or_default()));
    }

    let storage = eval_storage_snapshot(&window).await?;
    let mut cookies = window.cookies_for_url(expected.clone()).map_err(|err| err.to_string())?;
    if current.host_str() != expected.host_str() {
        if let Ok(current_cookies) = window.cookies_for_url(current.clone()) {
            for cookie in current_cookies {
                if !cookies.iter().any(|item| item.name() == cookie.name() && item.value() == cookie.value()) {
                    cookies.push(cookie);
                }
            }
        }
    }
    let cookie_header = cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ");
    let mut all = flatten_value(&storage);
    for cookie in cookies {
        all.push((cookie.name().to_string(), cookie.value().to_string()));
    }

    let mut token = pick_named_value(&all, &["auth_token", "authToken", "access_token", "accessToken", "bearerToken", "jwt", "token"]);
    let refresh = pick_named_value(&all, &["refresh_token", "refreshToken", "refresh"]);
    let expires = pick_named_value(&all, &["token_expires_at", "tokenExpiresAt", "accessTokenExpiresAt", "expires_at", "expiresAt", "expireAt"]);
    let mut user_id = pick_named_value(&all, &["user_id", "userId", "uid", "id"]);

    if token.is_none() {
        token = pick_jwt_like_value(&all);
    }

    if site_type == Some("newapi") {
        if user_id.is_none() {
            if let Some(found) = fetch_newapi_user_id(client, &expected, token.as_deref(), Some(&cookie_header)).await {
                user_id = Some(found);
            }
        }
    }

    if token.is_none() && refresh.is_none() {
        return Err("登录窗口中未找到可用令牌。请确认已在该窗口完成登录，再点击读取令牌".to_string());
    }

    Ok(TokenResponse {
        ok: true,
        site_url: Some(expected.to_string()),
        page_url: Some(current.to_string()),
        source: Some("tauri-login-window".to_string()),
        error: None,
        auth_token: token.clone(),
        access_token: token,
        refresh_token: refresh,
        cookie: if cookie_header.is_empty() { None } else { Some(cookie_header) },
        token_expires_at: expires,
        user_id: user_id.clone(),
        user_id_js: user_id,
    })
}

async fn eval_storage_snapshot(window: &tauri::WebviewWindow) -> Result<Value, String> {
    let script = r#"(() => {
  const dump = store => {
    const out = {};
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      out[key] = store.getItem(key);
    }
    return out;
  };
  const safeJson = value => {
    try { return JSON.parse(value); } catch (_) { return value; }
  };
  const expand = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, safeJson(v)]));
  return {
    href: location.href,
    localStorage: expand(dump(localStorage)),
    sessionStorage: expand(dump(sessionStorage)),
    documentCookie: document.cookie || ''
  };
})()"#;
    let (tx, rx) = mpsc::channel();
    window.eval_with_callback(script, move |value| {
        let _ = tx.send(value);
    }).map_err(|err| err.to_string())?;
    let raw = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|_| "读取登录窗口数据超时".to_string())?;
    serde_json::from_str(&raw).map_err(|err| err.to_string())
}

fn flatten_value(value: &Value) -> Vec<(String, String)> {
    fn walk(path: String, value: &Value, out: &mut Vec<(String, String)>) {
        match value {
            Value::String(text) => {
                out.push((path.clone(), text.clone()));
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    walk(path, &parsed, out);
                }
            }
            Value::Number(number) => out.push((path, number.to_string())),
            Value::Bool(flag) => out.push((path, flag.to_string())),
            Value::Array(items) => {
                for (idx, item) in items.iter().enumerate() {
                    walk(format!("{path}.{idx}"), item, out);
                }
            }
            Value::Object(map) => {
                for (key, item) in map {
                    let next = if path.is_empty() { key.to_string() } else { format!("{path}.{key}") };
                    walk(next, item, out);
                }
            }
            Value::Null => {}
        }
    }
    let mut out = Vec::new();
    walk(String::new(), value, &mut out);
    out
}

fn pick_named_value(values: &[(String, String)], names: &[&str]) -> Option<String> {
    let normalized_names: Vec<String> = names.iter().map(|name| normalize_key(name)).collect();
    for (key, value) in values {
        let leaf = key.rsplit('.').next().unwrap_or(key);
        let normalized_leaf = normalize_key(leaf);
        if normalized_names.iter().any(|name| &normalized_leaf == name) && useful_token_value(value) {
            return Some(value.trim().to_string());
        }
    }
    for (key, value) in values {
        let normalized_key = normalize_key(key);
        if normalized_names.iter().any(|name| normalized_key.contains(name)) && useful_token_value(value) {
            return Some(value.trim().to_string());
        }
    }
    None
}

fn normalize_key(value: &str) -> String {
    value.chars().filter(|ch| ch.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase()
}

fn pick_jwt_like_value(values: &[(String, String)]) -> Option<String> {
    values.iter()
        .find(|(_, value)| {
            let text = value.trim();
            text.len() > 24 && text.matches('.').count() == 2 && text.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '='))
        })
        .map(|(_, value)| value.trim().to_string())
}

fn useful_token_value(value: &str) -> bool {
    let text = value.trim();
    !text.is_empty() && text != "null" && text != "undefined" && text != "0"
}

async fn fetch_newapi_user_id(client: &reqwest::Client, base: &Url, token: Option<&str>, cookie_header: Option<&str>) -> Option<String> {
    let mut url = base.clone();
    url.set_path("/api/user/self");
    url.set_query(None);
    url.set_fragment(None);

    let mut request = client.get(url);
    if let Some(cookie) = cookie_header.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.header("Cookie", cookie);
    }
    if let Some(token) = token.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.header("Authorization", if token.to_ascii_lowercase().starts_with("bearer ") { token.to_string() } else { format!("Bearer {token}") });
    }

    let response = request.send().await.ok()?;
    let value = response.json::<Value>().await.ok()?;
    find_user_id(&value)
}

fn find_user_id(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in ["id", "user_id", "userId", "uid"] {
                if let Some(value) = map.get(key) {
                    if let Some(text) = scalar_to_string(value) {
                        return Some(text);
                    }
                }
            }
            for value in map.values() {
                if let Some(found) = find_user_id(value) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(find_user_id),
        _ => None,
    }
}

fn scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn site_hosts_match(current_host: &str, expected_host: &str) -> bool {
    let current = normalize_host(current_host);
    let expected = normalize_host(expected_host);
    if current.is_empty() || expected.is_empty() {
        return false;
    }
    current == expected || current.ends_with(&format!(".{expected}")) || expected.ends_with(&format!(".{current}")) || registrable_host(&current) == registrable_host(&expected)
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

fn registrable_host(host: &str) -> String {
    let labels: Vec<&str> = host.split('.').filter(|part| !part.is_empty()).collect();
    if labels.len() <= 2 {
        return labels.join(".");
    }
    let last_two = labels[labels.len() - 2..].join(".");
    let multi_part = ["com.cn", "net.cn", "org.cn", "gov.cn", "com.hk", "com.tw", "co.uk", "org.uk", "com.au", "net.au", "co.jp", "co.kr", "com.sg"];
    if multi_part.contains(&last_two.as_str()) {
        labels[labels.len() - 3..].join(".")
    } else {
        last_two
    }
}

async fn do_fetch(app: &AppHandle, client: &reqwest::Client, payload: FetchPayload) -> Result<FetchResponse, String> {
    let url = Url::parse(&payload.url).map_err(|err| err.to_string())?;
    if payload.browser_fetch == Some(true) && payload.kind.as_deref() == Some("channel") {
        return do_browser_fetch(app, &url, payload).await;
    }
    let method = payload.method.unwrap_or_else(|| "GET".to_string()).parse().map_err(|err| format!("invalid method: {err}"))?;
    let mut request = client.request(method, url);
    let headers = sanitize_headers(payload.headers.as_ref());
    request = request.headers(headers);

    if payload.kind.as_deref() == Some("channel") {
        request = request.header("Accept", "application/json, text/plain, */*");
        request = request.header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    }

    if let Some(body64) = payload.body_base64.filter(|value| !value.is_empty()) {
        let bytes = general_purpose::STANDARD.decode(body64).map_err(|err| err.to_string())?;
        request = request.body(bytes);
    } else if let Some(body) = payload.body {
        request = request.body(body);
    }

    let res = request.send().await.map_err(|err| err.to_string())?;
    let status = res.status().as_u16();
    let ok = res.status().is_success();
    let mut response_headers = Map::new();
    for (key, value) in res.headers().iter() {
        response_headers.insert(key.to_string(), Value::String(value.to_str().unwrap_or_default().to_string()));
    }

    let bytes = res.bytes().await.map_err(|err| err.to_string())?;
    let body = if payload.response_type.as_deref() == Some("base64") {
        general_purpose::STANDARD.encode(&bytes)
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };

    Ok(FetchResponse { ok, status, headers: response_headers, body, error: None })
}

async fn do_browser_fetch(app: &AppHandle, url: &Url, payload: FetchPayload) -> Result<FetchResponse, String> {
    let site_url = payload.site_url.as_deref().unwrap_or(&payload.url);
    let expected = Url::parse(site_url).map_err(|_| "浏览器请求模式缺少有效的渠道站点地址".to_string())?;
    if !site_hosts_match(url.host_str().unwrap_or_default(), expected.host_str().unwrap_or_default()) {
        return Err(format!("请求域名 {} 与渠道站点 {} 不匹配", url.host_str().unwrap_or_default(), expected.host_str().unwrap_or_default()));
    }
    let site_type = payload.site_type.as_deref().unwrap_or("channel");
    let window = ensure_login_window(app, false)?;
    let mut current = window.url().map_err(|err| err.to_string())?;
    if !site_hosts_match(current.host_str().unwrap_or_default(), expected.host_str().unwrap_or_default()) {
        let login = login_url(site_url, payload.site_type.as_deref())?;
        window.navigate(login).map_err(|err| err.to_string())?;
        sleep_async(Duration::from_millis(1200)).await?;
        current = window.url().map_err(|err| err.to_string())?;
    }
    if !site_hosts_match(current.host_str().unwrap_or_default(), expected.host_str().unwrap_or_default()) {
        return Err(format!("{site_type} 浏览器请求模式需要打开登录页并完成登录"));
    }

    let request_id = format!("relay_fetch_{}", BROWSER_FETCH_SEQ.fetch_add(1, Ordering::Relaxed));
    window.eval(browser_fetch_start_script(&payload, &request_id)?).map_err(|err| err.to_string())?;

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        sleep_async(Duration::from_millis(200)).await?;
        let raw = eval_with_callback(&window, browser_fetch_poll_script(&request_id)?, Duration::from_secs(5)).await?;
        let value: Value = serde_json::from_str(&raw).map_err(|err| err.to_string())?;
        if !value.is_null() {
            return parse_browser_fetch_response(&raw);
        }
    }
    let _ = window.eval(browser_fetch_cleanup_script(&request_id)?);
    Err("浏览器请求超时".to_string())
}

fn browser_fetch_start_script(payload: &FetchPayload, request_id: &str) -> Result<String, String> {
    if payload.response_type.as_deref() == Some("base64") || payload.body_base64.as_deref().is_some_and(|value| !value.is_empty()) {
        return Err("浏览器请求模式暂不支持二进制请求或响应".to_string());
    }
    let id = serde_json::to_string(request_id).map_err(|err| err.to_string())?;
    let url = serde_json::to_string(&payload.url).map_err(|err| err.to_string())?;
    let method = serde_json::to_string(payload.method.as_deref().unwrap_or("GET")).map_err(|err| err.to_string())?;
    let headers = serde_json::to_string(&browser_fetch_headers(payload.headers.as_ref())).map_err(|err| err.to_string())?;
    let body = serde_json::to_string(&payload.body.as_deref()).map_err(|err| err.to_string())?;
    let site_type = serde_json::to_string(payload.site_type.as_deref().unwrap_or_default()).map_err(|err| err.to_string())?;
    let auth_script = browser_fetch_auth_helper_script();
    Ok(format!(r#"(() => {{
  const id = {id};
  const store = window.__relayHubFetchResults = window.__relayHubFetchResults || {{}};
  store[id] = {{ done: false, result: null }};
  (async () => {{
    try {{
      const body = {body};
      const siteType = {site_type};
      const headers = {headers};
{auth_script}
      const pageAuth = await relayHubCollectPageAuth(siteType);
      if (pageAuth.token) relayHubSetHeader(headers, 'Authorization', /^Bearer\s+/i.test(pageAuth.token) ? pageAuth.token : 'Bearer ' + pageAuth.token);
      if (siteType === 'newapi' && pageAuth.userId) relayHubSetHeader(headers, 'New-Api-User', pageAuth.userId);
      const init = {{
        method: {method},
        headers,
        credentials: 'include',
        cache: 'no-store'
      }};
      if (body !== null && !/^(GET|HEAD)$/i.test(init.method)) init.body = body;
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 25000) : null;
      if (controller) init.signal = controller.signal;
      let res;
      try {{
        res = await fetch({url}, init);
      }} catch (err) {{
        if (err && err.name === 'AbortError') throw new Error('浏览器请求超时');
        throw err;
      }} finally {{
        if (timer) clearTimeout(timer);
      }}
      const responseHeaders = {{}};
      res.headers.forEach((value, key) => {{ responseHeaders[key] = value; }});
      store[id] = {{ done: true, result: {{ ok: res.ok, status: res.status, headers: responseHeaders, body: await res.text() }} }};
    }} catch (err) {{
      store[id] = {{ done: true, result: {{ ok: false, status: 0, headers: {{}}, body: '', error: err && err.message ? err.message : String(err) }} }};
    }}
  }})();
  return true;
}})()"#))
}

fn browser_fetch_auth_helper_script() -> &'static str {
    r#"      function relayHubSetHeader(headers, name, value) {
        if (!value) return;
        const lower = name.toLowerCase();
        Object.keys(headers).forEach(key => {
          if (key.toLowerCase() === lower) delete headers[key];
        });
        headers[name] = String(value);
      }
      async function relayHubCollectPageAuth(siteType) {
        const dump = store => {
          const out = {};
          for (let i = 0; i < store.length; i += 1) {
            const key = store.key(i);
            out[key] = store.getItem(key);
          }
          return out;
        };
        const safeJson = value => {
          try { return JSON.parse(value); } catch (_) { return value; }
        };
        const flatten = value => {
          const out = [];
          const walk = (path, item) => {
            if (item == null) return;
            if (typeof item === 'string') {
              out.push([path, item]);
              const parsed = safeJson(item);
              if (parsed !== item) walk(path, parsed);
            } else if (typeof item === 'number' || typeof item === 'boolean') {
              out.push([path, String(item)]);
            } else if (Array.isArray(item)) {
              item.forEach((child, index) => walk(`${path}.${index}`, child));
            } else if (typeof item === 'object') {
              Object.entries(item).forEach(([key, child]) => walk(path ? `${path}.${key}` : key, child));
            }
          };
          walk('', value);
          return out;
        };
        const normalize = value => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        const useful = value => {
          const text = String(value || '').trim();
          return text && text !== 'null' && text !== 'undefined' && text !== '0';
        };
        const pick = (values, names) => {
          const wanted = names.map(normalize);
          for (const [key, value] of values) {
            const leaf = String(key || '').split('.').pop();
            if (wanted.includes(normalize(leaf)) && useful(value)) return String(value).trim();
          }
          for (const [key, value] of values) {
            const normalized = normalize(key);
            if (wanted.some(name => normalized.includes(name)) && useful(value)) return String(value).trim();
          }
          return '';
        };
        const pickJwt = values => {
          const hit = values.find(([, value]) => {
            const text = String(value || '').trim();
            return text.length > 24 && (text.match(/\./g) || []).length === 2 && /^[A-Za-z0-9._=-]+$/.test(text);
          });
          return hit ? String(hit[1]).trim() : '';
        };
        const findUserId = value => {
          if (value == null) return '';
          if (Array.isArray(value)) return value.map(findUserId).find(Boolean) || '';
          if (typeof value !== 'object') return '';
          for (const key of ['id', 'user_id', 'userId', 'uid']) {
            const item = value[key];
            if (typeof item === 'string' && item.trim()) return item.trim();
            if (typeof item === 'number') return String(item);
          }
          return Object.values(value).map(findUserId).find(Boolean) || '';
        };
        const storage = {
          localStorage: Object.fromEntries(Object.entries(dump(localStorage)).map(([key, value]) => [key, safeJson(value)])),
          sessionStorage: Object.fromEntries(Object.entries(dump(sessionStorage)).map(([key, value]) => [key, safeJson(value)])),
          documentCookie: document.cookie || ''
        };
        const values = flatten(storage);
        String(document.cookie || '').split(';').forEach(part => {
          const index = part.indexOf('=');
          if (index > 0) values.push([part.slice(0, index).trim(), part.slice(index + 1).trim()]);
        });
        const token = pick(values, ['auth_token', 'authToken', 'access_token', 'accessToken', 'bearerToken', 'jwt', 'token']) || pickJwt(values);
        const userId = pick(values, ['user_id', 'userId', 'uid', 'id']);
        return { token, userId };
      }
"#
}

fn browser_fetch_poll_script(request_id: &str) -> Result<String, String> {
    let id = serde_json::to_string(request_id).map_err(|err| err.to_string())?;
    Ok(format!(r#"(() => {{
  const store = window.__relayHubFetchResults || {{}};
  const item = store[{id}];
  if (!item || !item.done) return null;
  delete store[{id}];
  return item.result || null;
}})()"#))
}

fn browser_fetch_cleanup_script(request_id: &str) -> Result<String, String> {
    let id = serde_json::to_string(request_id).map_err(|err| err.to_string())?;
    Ok(format!(r#"(() => {{
  const store = window.__relayHubFetchResults || {{}};
  delete store[{id}];
}})()"#))
}

async fn eval_with_callback(window: &tauri::WebviewWindow, script: String, timeout: Duration) -> Result<String, String> {
    let (tx, rx) = mpsc::channel();
    window.eval_with_callback(script, move |value| {
        let _ = tx.send(value);
    }).map_err(|err| err.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|_| "读取浏览器请求结果超时".to_string())
}

async fn sleep_async(duration: Duration) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || thread::sleep(duration))
        .await
        .map_err(|err| err.to_string())
}

fn browser_fetch_headers(input: Option<&Map<String, Value>>) -> Map<String, Value> {
    let forbidden: HashSet<&'static str> = [
        "accept-charset", "accept-encoding", "access-control-request-headers",
        "access-control-request-method", "connection", "content-length", "cookie",
        "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin",
        "permissions-policy", "referer", "te", "trailer", "transfer-encoding",
        "upgrade", "user-agent", "via",
    ].into_iter().collect();
    let mut headers = Map::new();
    if let Some(input) = input {
        for (key, value) in input.iter() {
            let name = key.trim();
            let lower = name.to_ascii_lowercase();
            if name.is_empty() || lower.starts_with("proxy-") || lower.starts_with("sec-") || forbidden.contains(lower.as_str()) {
                continue;
            }
            if let Some(text) = value.as_str() {
                headers.insert(name.to_string(), Value::String(text.to_string()));
            }
        }
    }
    headers
}

fn parse_browser_fetch_response(raw: &str) -> Result<FetchResponse, String> {
    let mut value: Value = serde_json::from_str(raw).map_err(|err| err.to_string())?;
    if let Some(text) = value.as_str() {
        value = serde_json::from_str(text).map_err(|err| err.to_string())?;
    }
    let Some(map) = value.as_object() else {
        return Err("浏览器请求返回格式无效".to_string());
    };
    let headers = map.get("headers").and_then(Value::as_object).cloned().unwrap_or_default();
    Ok(FetchResponse {
        ok: map.get("ok").and_then(Value::as_bool).unwrap_or(false),
        status: map.get("status").and_then(Value::as_u64).unwrap_or(0) as u16,
        headers,
        body: map.get("body").and_then(Value::as_str).unwrap_or_default().to_string(),
        error: map.get("error").and_then(Value::as_str).map(str::to_string),
    })
}

fn sanitize_headers(input: Option<&Map<String, Value>>) -> HeaderMap {
    let forbidden: HashSet<&'static str> = [
        "accept-charset", "accept-encoding", "access-control-request-headers",
        "access-control-request-method", "connection", "content-length",
        "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin",
        "permissions-policy", "referer", "te", "trailer", "transfer-encoding",
        "upgrade", "user-agent", "via",
    ].into_iter().collect();
    let mut headers = HeaderMap::new();
    if let Some(input) = input {
        for (key, value) in input.iter() {
            let name = key.trim();
            let lower = name.to_ascii_lowercase();
            if name.is_empty() || lower.starts_with("proxy-") || lower.starts_with("sec-") || forbidden.contains(lower.as_str()) {
                continue;
            }
            let Some(text) = value.as_str() else { continue };
            if let (Ok(header_name), Ok(header_value)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(text)) {
                headers.insert(header_name, header_value);
            }
        }
    }
    headers
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            setup_tray(app)?;
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        hide_main_window(&app_handle);
                    }
                });
            }
            start_minimize_watcher(app.handle().clone());
            let store = load_store(&app.handle());
            app.manage(AppState {
                store: Mutex::new(store),
                client: reqwest::Client::builder()
                    .cookie_store(true)
                    .build()
                    .map_err(|err| Box::<dyn std::error::Error>::from(err))?,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            relay_store_get,
            relay_store_set,
            relay_open_mode_get,
            relay_open_mode_set,
            relay_open_sidepanel,
            relay_copy_text,
            relay_open_external,
            relay_open_site_login,
            relay_read_site_tokens,
            relay_fetch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Relay Hub Tauri app");
}
