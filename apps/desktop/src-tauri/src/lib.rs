mod commands;
mod dump;
mod state;
mod tools;

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
        // Auto-updater. The updater plugin polls the configured
        // endpoint, verifies bundle signatures against the embedded
        // public key (`bundle.updater.pubkey` in tauri.conf.json),
        // and downloads + installs the new build on the user's
        // request. The matching `process` plugin lets the frontend
        // call `relaunch()` after install so the new binary takes
        // over without the user manually closing + reopening.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Native file picker for Export (save) and Import (open).
        // Frontend calls tauri-plugin-dialog's save/open helpers.
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        // Export/import job registry lives alongside the driver
        // registry so cancel commands can look up the running child.
        .manage(std::sync::Arc::new(dump::export::ExportRegistry::new()))
        .manage(std::sync::Arc::new(dump::import::ImportRegistry::new()))
        .invoke_handler(tauri::generate_handler![
            commands::list_engines,
            commands::test_connection,
            commands::get_schema,
            commands::get_server_info,
            commands::dry_run_statements,
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
            commands::cancel_query,
            commands::mongo_ping,
            commands::mongo_list_databases,
            commands::mongo_list_collections,
            commands::mongo_find,
            commands::mongo_insert_one,
            commands::mongo_replace_one,
            commands::mongo_delete_one,
            commands::mongo_disconnect,
            commands::redis_ping,
            commands::redis_scan,
            commands::redis_key_details,
            commands::redis_delete,
            commands::redis_disconnect,
            tools::list_tool_bundles,
            tools::install_tool_bundle,
            tools::uninstall_tool_bundle,
            dump::detect_dump_format,
            dump::file_size,
            dump::start_export,
            dump::cancel_export,
            dump::start_import,
            dump::cancel_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running dbstudio");
}
