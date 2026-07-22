#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env,
    ffi::OsString,
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, Position, State, WebviewWindow, WindowEvent,
};

const PANEL_WIDTH: f64 = 382.0;
const PANEL_HEIGHT: f64 = 610.0;
const ISLAND_WIDTH: f64 = 326.0;
const ISLAND_HEIGHT: f64 = 44.0;
const ISLAND_EXPANDED_WIDTH: f64 = 410.0;
const ISLAND_EXPANDED_HEIGHT: f64 = 122.0;
const MAX_CONTROL_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_ERROR_LENGTH: usize = 1_000;

#[derive(Clone)]
struct RouterState {
    source_root: Option<PathBuf>,
    settings_path: PathBuf,
    settings: Arc<Mutex<DesktopSettings>>,
    platform: PlatformInfo,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    os: String,
    session: String,
    island_supported: bool,
    island_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct DesktopSettings {
    island_enabled: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            island_enabled: true,
        }
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            platform_info,
            desktop_settings,
            router_health,
            control_snapshot,
            account_usage,
            provider_usage,
            provider_setup,
            install_provider_cli,
            connect_oauth,
            save_api_key,
            set_provider_enabled,
            set_island_enabled,
            set_island_expanded,
            show_panel,
            hide_panel,
            quit_app
        ])
        .setup(|app| {
            let platform = detect_platform();
            let settings_path = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("desktop-settings.json");
            let settings = load_settings(&settings_path);
            let should_show_island = platform.island_supported && settings.island_enabled;

            app.manage(RouterState {
                source_root: resolve_source_root(app.handle()),
                settings_path,
                settings: Arc::new(Mutex::new(settings)),
                platform,
            });

            install_tray(app)?;

            if should_show_island {
                show_island_window(app.handle(), false)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "panel" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Codex Model Router desktop companion");
}

fn install_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Model Router", true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        "toggle-island",
        "Toggle activity pill",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &toggle, &quit])?;

    let mut builder = TrayIconBuilder::with_id("model-router")
        .tooltip("Codex Model Router")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "linux"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let _ = show_panel_window(app);
            }
            "toggle-island" => {
                let state = app.state::<RouterState>();
                if state.platform.island_supported {
                    let enabled = state
                        .settings
                        .lock()
                        .map(|settings| !settings.island_enabled)
                        .unwrap_or(false);
                    let _ = update_island_enabled(app, state.inner(), enabled);
                } else {
                    let _ = show_panel_window(app);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                #[cfg(target_os = "windows")]
                {
                    let _ = show_panel_window(_tray.app_handle());
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[tauri::command]
fn platform_info(state: State<'_, RouterState>) -> PlatformInfo {
    state.platform.clone()
}

#[tauri::command]
fn desktop_settings(state: State<'_, RouterState>) -> Result<DesktopSettings, String> {
    state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Desktop settings are temporarily unavailable.".to_string())
}

#[tauri::command]
async fn router_health() -> Value {
    tauri::async_runtime::spawn_blocking(read_router_health)
        .await
        .unwrap_or_else(|_| offline_health("Router health check did not finish."))
}

#[tauri::command]
async fn control_snapshot(state: State<'_, RouterState>) -> Result<Value, String> {
    run_json_command(state.inner().clone(), vec!["--json".into()], None).await
}

#[tauri::command]
async fn account_usage(state: State<'_, RouterState>) -> Result<Value, String> {
    run_json_command(
        state.inner().clone(),
        vec!["account".into(), "--json".into()],
        None,
    )
    .await
}

#[tauri::command]
async fn provider_usage(state: State<'_, RouterState>) -> Result<Value, String> {
    run_json_command(
        state.inner().clone(),
        vec!["provider-usage".into(), "--json".into()],
        None,
    )
    .await
}

#[tauri::command]
async fn provider_setup(state: State<'_, RouterState>) -> Result<Value, String> {
    run_json_command(
        state.inner().clone(),
        vec!["providers".into(), "--json".into()],
        None,
    )
    .await
}

#[tauri::command]
async fn install_provider_cli(
    state: State<'_, RouterState>,
    provider: String,
) -> Result<Value, String> {
    validate_provider_kind(&provider, ProviderKind::Oauth)?;
    run_json_command(
        state.inner().clone(),
        vec!["install-cli".into(), provider],
        None,
    )
    .await
}

#[tauri::command]
async fn connect_oauth(state: State<'_, RouterState>, provider: String) -> Result<Value, String> {
    validate_provider_kind(&provider, ProviderKind::Oauth)?;
    let router = state.inner().clone();
    let provider_for_login = provider.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_control(&router, &["login", &provider_for_login], None)?;
        update_provider_selection(&router, &provider_for_login, true)?;
        run_control_json(&router, &["providers", "--json"], None)
    })
    .await
    .map_err(|_| "Provider sign-in did not finish.".to_string())?
}

#[tauri::command]
async fn save_api_key(
    state: State<'_, RouterState>,
    provider: String,
    api_key: String,
) -> Result<Value, String> {
    validate_provider_kind(&provider, ProviderKind::Api)?;
    if api_key.trim().is_empty() {
        return Err("Enter an API key first.".into());
    }
    if api_key.len() > 16 * 1024 {
        return Err("The API key is too large.".into());
    }

    let router = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_control(
            &router,
            &["credential", &provider],
            Some(api_key.as_bytes()),
        )?;
        update_provider_selection(&router, &provider, true)?;
        run_control_json(&router, &["providers", "--json"], None)
    })
    .await
    .map_err(|_| "The API key operation did not finish.".to_string())?
}

#[tauri::command]
async fn set_provider_enabled(
    state: State<'_, RouterState>,
    provider: String,
    enabled: bool,
) -> Result<Value, String> {
    validate_provider(&provider)?;
    let router = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        update_provider_selection(&router, &provider, enabled)?;
        run_control_json(&router, &["--json"], None)
    })
    .await
    .map_err(|_| "The provider change did not finish.".to_string())?
}

#[tauri::command]
fn set_island_enabled(
    app: AppHandle,
    state: State<'_, RouterState>,
    enabled: bool,
) -> Result<bool, String> {
    update_island_enabled(&app, state.inner(), enabled)?;
    Ok(enabled)
}

#[tauri::command]
fn set_island_expanded(
    app: AppHandle,
    state: State<'_, RouterState>,
    expanded: bool,
) -> Result<(), String> {
    if !state.platform.island_supported {
        return Ok(());
    }
    show_island_window(&app, expanded)
}

#[tauri::command]
fn show_panel(app: AppHandle) -> Result<(), String> {
    show_panel_window(&app)
}

#[tauri::command]
fn hide_panel(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("panel")
        .ok_or_else(|| "The tray panel is unavailable.".to_string())?;
    window.hide().map_err(display_error)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

async fn run_json_command(
    state: RouterState,
    args: Vec<String>,
    stdin: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
        run_control_json(&state, &borrowed, stdin.as_deref().map(str::as_bytes))
    })
    .await
    .map_err(|_| "The Model Router command did not finish.".to_string())?
}

fn update_provider_selection(
    state: &RouterState,
    provider: &str,
    enabled: bool,
) -> Result<(), String> {
    let overview = run_control_json(state, &["--json"], None)?;
    let was_enabled = overview
        .pointer("/targets/codex/enabledProviders")
        .and_then(Value::as_array)
        .map(|providers| providers.iter().any(|item| item.as_str() == Some(provider)))
        .unwrap_or(false);
    let desired = if enabled { "on" } else { "off" };
    run_control(
        state,
        &["set", provider, desired, "--targets", "codex"],
        None,
    )?;

    if let Err(error) = run_control(state, &["apply", "--targets", "codex", "--activate"], None) {
        let previous = if was_enabled { "on" } else { "off" };
        let _ = run_control(
            state,
            &["set", provider, previous, "--targets", "codex"],
            None,
        );
        let _ = run_control(state, &["apply", "--targets", "codex", "--activate"], None);
        return Err(error);
    }
    Ok(())
}

fn run_control_json(
    state: &RouterState,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Result<Value, String> {
    let output = run_control(state, args, stdin)?;
    serde_json::from_slice(&output)
        .map_err(|_| "Model Router returned an unreadable response.".to_string())
}

fn run_control(
    state: &RouterState,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let root = state.source_root.as_ref().ok_or_else(|| {
        "Model Router was not found. Install it in the standard location or set MODEL_ROUTER_SOURCE_ROOT."
            .to_string()
    })?;
    let node = resolve_node().ok_or_else(|| {
        "Node.js 22.19 or newer was not found. Add Node.js to PATH and reopen the tray app."
            .to_string()
    })?;

    let mut command = Command::new(node);
    command
        .arg(root.join("src/control.mjs"))
        .args(args)
        .current_dir(root)
        .env("MODEL_ROUTER_TARGET", "codex")
        .env("PATH", augmented_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });

    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the Model Router control process.".to_string())?;
    if let Some(input) = stdin {
        let mut pipe = child
            .stdin
            .take()
            .ok_or_else(|| "Could not securely pass the API key.".to_string())?;
        pipe.write_all(input)
            .map_err(|_| "Could not securely pass the API key.".to_string())?;
    }
    let output = child
        .wait_with_output()
        .map_err(|_| "The Model Router control process did not finish.".to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(sanitize_error(&detail));
    }
    if output.stdout.len() > MAX_CONTROL_OUTPUT {
        return Err("Model Router returned more data than the desktop app can display.".into());
    }
    Ok(output.stdout)
}

fn read_router_health() -> Value {
    let port = env::var("MODEL_ROUTER_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(4102);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(500)) {
        Ok(stream) => stream,
        Err(_) => return offline_health("Router is offline."),
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return offline_health("Router health check failed.");
    }
    let mut response = Vec::new();
    if stream.take(64 * 1024).read_to_end(&mut response).is_err() {
        return offline_health("Router health check failed.");
    }
    parse_health_response(&response)
        .unwrap_or_else(|| offline_health("Router returned an unreadable health response."))
}

fn parse_health_response(response: &[u8]) -> Option<Value> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&response[..separator]);
    let status_ok = head
        .lines()
        .next()
        .map(|line| line.contains(" 200 "))
        .unwrap_or(false);
    if !status_ok {
        return None;
    }
    serde_json::from_slice(&response[separator + 4..]).ok()
}

fn offline_health(message: &str) -> Value {
    json!({
        "ok": false,
        "error": message,
        "activity": {
            "state": "offline",
            "activeCount": 0,
            "active": []
        }
    })
}

fn update_island_enabled(
    app: &AppHandle,
    state: &RouterState,
    enabled: bool,
) -> Result<(), String> {
    if enabled && !state.platform.island_supported {
        return Err(state
            .platform
            .island_reason
            .clone()
            .unwrap_or_else(|| "The activity pill is not supported on this desktop.".into()));
    }
    {
        let mut settings = state
            .settings
            .lock()
            .map_err(|_| "Desktop settings are temporarily unavailable.".to_string())?;
        settings.island_enabled = enabled;
        save_settings(&state.settings_path, &settings)?;
    }
    if enabled {
        show_island_window(app, false)
    } else if let Some(window) = app.get_webview_window("island") {
        window.hide().map_err(display_error)
    } else {
        Ok(())
    }
}

fn show_panel_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("panel")
        .ok_or_else(|| "The tray panel is unavailable.".to_string())?;
    position_panel(&window)?;
    window.show().map_err(display_error)?;
    window.set_focus().map_err(display_error)
}

fn show_island_window(app: &AppHandle, expanded: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("island")
        .ok_or_else(|| "The activity pill is unavailable.".to_string())?;
    let (width, height) = if expanded {
        (ISLAND_EXPANDED_WIDTH, ISLAND_EXPANDED_HEIGHT)
    } else {
        (ISLAND_WIDTH, ISLAND_HEIGHT)
    };
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(display_error)?;
    position_island(&window, width)?;
    window.show().map_err(display_error)
}

fn position_island(window: &WebviewWindow, logical_width: f64) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(display_error)?
        .or(window.primary_monitor().map_err(display_error)?)
        .ok_or_else(|| "No display is available for the activity pill.".to_string())?;
    let scale = monitor.scale_factor();
    let window_width = (logical_width * scale).round() as i32;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let x = centered_x(monitor_position.x, monitor_size.width as i32, window_width);
    let y = monitor_position.y + (8.0 * scale).round() as i32;
    window
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(display_error)
}

fn position_panel(window: &WebviewWindow) -> Result<(), String> {
    if detect_platform().session == "wayland" {
        return Ok(());
    }
    let monitor = window
        .current_monitor()
        .map_err(display_error)?
        .or(window.primary_monitor().map_err(display_error)?)
        .ok_or_else(|| "No display is available for the tray panel.".to_string())?;
    let scale = monitor.scale_factor();
    let width = (PANEL_WIDTH * scale).round() as i32;
    let height = (PANEL_HEIGHT * scale).round() as i32;
    let margin = (16.0 * scale).round() as i32;
    let taskbar_allowance = (56.0 * scale).round() as i32;
    let (x, y) = panel_position(
        monitor.position().x,
        monitor.position().y,
        monitor.size().width as i32,
        monitor.size().height as i32,
        width,
        height,
        margin,
        taskbar_allowance,
    );
    window
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(display_error)
}

fn centered_x(monitor_x: i32, monitor_width: i32, window_width: i32) -> i32 {
    monitor_x + (monitor_width - window_width) / 2
}

#[allow(clippy::too_many_arguments)]
fn panel_position(
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: i32,
    monitor_height: i32,
    window_width: i32,
    window_height: i32,
    margin: i32,
    taskbar_allowance: i32,
) -> (i32, i32) {
    (
        monitor_x + monitor_width - window_width - margin,
        monitor_y + monitor_height - window_height - taskbar_allowance,
    )
}

fn detect_platform() -> PlatformInfo {
    #[cfg(target_os = "windows")]
    {
        PlatformInfo {
            os: "windows".into(),
            session: "desktop".into(),
            island_supported: true,
            island_reason: None,
        }
    }
    #[cfg(target_os = "linux")]
    {
        let explicit = env::var("XDG_SESSION_TYPE")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let wayland = explicit == "wayland" || env::var_os("WAYLAND_DISPLAY").is_some();
        PlatformInfo {
            os: "linux".into(),
            session: if wayland { "wayland" } else { "x11" }.into(),
            island_supported: !wayland,
            island_reason: wayland.then(|| {
                "Wayland controls window placement, so the top-center activity pill is disabled. The tray panel remains available."
                    .into()
            }),
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        PlatformInfo {
            os: env::consts::OS.into(),
            session: "native".into(),
            island_supported: false,
            island_reason: Some("Use the native macOS menu bar companion on this platform.".into()),
        }
    }
}

fn resolve_source_root(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(configured) = env::var_os("MODEL_ROUTER_SOURCE_ROOT") {
        candidates.push(PathBuf::from(configured));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Ok(saved) = fs::read_to_string(resource_dir.join("router-root")) {
            candidates.push(PathBuf::from(saved.trim()));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."));
    if let Ok(current) = env::current_dir() {
        candidates.extend(current.ancestors().map(Path::to_path_buf));
    }
    candidates.extend(standard_source_roots());
    candidates
        .into_iter()
        .find(|candidate| candidate.join("src/control.mjs").is_file())
        .and_then(|candidate| candidate.canonicalize().ok().or(Some(candidate)))
}

fn standard_source_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "windows")]
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("codex-router"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(data) = env::var_os("XDG_DATA_HOME") {
            roots.push(PathBuf::from(data).join("codex-router"));
        }
        if let Some(home) = env::var_os("HOME") {
            roots.push(PathBuf::from(home).join(".local/share/codex-router"));
        }
    }
    roots
}

fn resolve_node() -> Option<OsString> {
    if let Some(configured) = env::var_os("MODEL_ROUTER_NODE") {
        if !configured.is_empty() {
            return Some(configured);
        }
    }
    let executable = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };
    for directory in env::split_paths(&augmented_path()) {
        let candidate = directory.join(executable);
        if candidate.is_file() {
            return Some(candidate.into_os_string());
        }
    }
    None
}

fn augmented_path() -> OsString {
    let mut entries = Vec::new();
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        entries.push(home.join(".npm-global/bin"));
        entries.push(home.join(".local/bin"));
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(program_files) = env::var_os("ProgramFiles") {
            entries.push(PathBuf::from(program_files).join("nodejs"));
        }
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            entries.push(PathBuf::from(local).join("Programs/nodejs"));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        entries.push(PathBuf::from("/opt/homebrew/bin"));
        entries.push(PathBuf::from("/usr/local/bin"));
        entries.push(PathBuf::from("/usr/bin"));
    }
    if let Some(current) = env::var_os("PATH") {
        entries.extend(env::split_paths(&current));
    }
    env::join_paths(entries).unwrap_or_else(|_| env::var_os("PATH").unwrap_or_default())
}

fn load_settings(path: &Path) -> DesktopSettings {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_settings(path: &Path, settings: &DesktopSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Could not create the desktop settings directory.".to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|_| "Could not encode desktop settings.".to_string())?;
    fs::write(path, bytes).map_err(|_| "Could not save desktop settings.".to_string())
}

#[derive(Clone, Copy)]
enum ProviderKind {
    Oauth,
    Api,
}

fn validate_provider(provider: &str) -> Result<(), String> {
    const PROVIDERS: &[&str] = &[
        "anthropic-api",
        "kimi-oauth",
        "kimi-api",
        "deepseek",
        "grok-api",
        "grok-oauth",
    ];
    if PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err("Unknown provider.".into())
    }
}

fn validate_provider_kind(provider: &str, kind: ProviderKind) -> Result<(), String> {
    validate_provider(provider)?;
    let is_oauth = matches!(provider, "kimi-oauth" | "grok-oauth");
    if is_oauth == matches!(kind, ProviderKind::Oauth) {
        Ok(())
    } else {
        Err("That provider does not support this connection method.".into())
    }
}

fn sanitize_error(raw: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return "Model Router control command failed.".into();
    }
    collapsed.chars().take(MAX_ERROR_LENGTH).collect()
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centers_island_on_offset_monitor() {
        assert_eq!(centered_x(1920, 2560, 410), 2995);
    }

    #[test]
    fn places_panel_inside_bottom_right_margin() {
        assert_eq!(
            panel_position(0, 0, 1920, 1080, 382, 610, 16, 56),
            (1522, 414)
        );
    }

    #[test]
    fn accepts_only_known_provider_ids() {
        assert!(validate_provider("kimi-oauth").is_ok());
        assert!(validate_provider("../../secret").is_err());
        assert!(validate_provider_kind("deepseek", ProviderKind::Api).is_ok());
        assert!(validate_provider_kind("deepseek", ProviderKind::Oauth).is_err());
    }

    #[test]
    fn parses_successful_health_response() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}";
        assert_eq!(
            parse_health_response(response).and_then(|value| value["ok"].as_bool()),
            Some(true)
        );
    }

    #[test]
    fn rejects_non_success_health_response() {
        let response = b"HTTP/1.1 503 Nope\r\n\r\n{}";
        assert!(parse_health_response(response).is_none());
    }
}
