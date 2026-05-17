mod commands;
mod state;

pub use state::AppState;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| {
                    "info,dbstudio=debug,dbstudio_core=debug,russh=info".into()
                }),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            // Resolve app data dir (`~/Library/Application Support/<bundle id>`
            // on macOS, `%APPDATA%\<bundle id>` on Windows) and initialise the
            // encrypted secrets store. Done synchronously before any command
            // runs so secrets::get/set always have a backing store.
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("resolve app data dir: {e}"))?;
            dbstudio_core::secrets::init(&data_dir)
                .map_err(|e| format!("init secrets store: {e}"))?;
            tracing::info!(path = %data_dir.display(), "secrets store ready");
            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::list_engines,
            commands::test_connection,
            commands::get_schema,
            commands::run_query,
            commands::set_secret,
            commands::has_secret,
            commands::delete_secret,
            commands::delete_secrets,
            commands::discover_host_key,
            commands::update_cell,
            commands::insert_row,
            commands::delete_row,
            commands::reconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running dbstudio");
}
