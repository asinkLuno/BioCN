pub mod analysis;
pub mod analyzer;
pub mod cache;
pub mod export;
pub mod library;
pub mod models;
pub(crate) mod net;
pub mod progress;
pub mod protocol;
pub mod reader;
pub mod reading;
pub mod settings;
pub mod text;
pub mod update;

use tauri::Manager;

/// Emitted whenever a whole-book coloring job changes state: started, moved to
/// the next chapter, finished, failed or cancelled.
pub const PROGRESS_EVENT: &str = "coloring://progress";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .register_asynchronous_uri_scheme_protocol("book", protocol::handle)
        .setup(|app| {
            // The minimal libonnxruntime is a bundled resource, so point the
            // engine at it before anything initializes ORT: engine::builder()
            // checks ORT_DYLIB_PATH first, then falls back to the executable
            // directory (Windows ships resources beside the binary, dev builds
            // run from the cargo output dir) and finally the bare SONAME.
            #[cfg(not(target_os = "android"))]
            {
                // Each platform bundles its own library as res/libonnxruntime.<ext>
                // (resources map in tauri.conf.json); resolve() handles the dev
                // (cargo output dir) and installed ($RESOURCES) cases.
                let ext = if cfg!(target_os = "macos") {
                    "dylib"
                } else if cfg!(windows) {
                    "dll"
                } else {
                    "so"
                };
                let ort = app
                    .path()
                    .resolve(
                        format!("res/libonnxruntime.{ext}"),
                        tauri::path::BaseDirectory::Resource,
                    )
                    .ok()
                    .filter(|p| p.is_file());
                if let Some(ort) = ort {
                    unsafe {
                        // Single-threaded launch; read only by builder().
                        std::env::set_var("ORT_DYLIB_PATH", ort);
                    }
                }
            }
            app.manage(library::init(app.handle())?);
            app.manage(progress::ProgressStore::init(app.handle())?);
            // The analysis cache lives beside the models rather than inside the
            // library: it is derived data, so losing it with the weights (or by
            // clearing app data) is a recompute and nothing else.
            let cache_dir = app.path().app_data_dir()?.join("models");
            app.manage(cache::AnalysisCache::open(&cache_dir)?);
            app.manage(analyzer::AnalyzerState::default());
            app.manage(reading::ReadingState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library::library_list,
            library::library_import,
            library::library_remove,
            library::library_cover,
            models::models_status,
            models::models_install,
            models::models_remove,
            models::models_activate,
            reading::book_open,
            reading::book_chapter_colorize,
            reading::book_chapter_prefetch,
            reading::book_chapter_cancel_stream,
            progress::book_progress_get,
            progress::book_progress_save,
            analyzer::colorize_book,
            analyzer::coloring_progress,
            analyzer::colorize_book_cancel,
            analyzer::clear_book_cache,
            analyzer::book_has_coloring,
            analyzer::book_has_active_coloring,
            export::export_book,
            update::check_update,
            update::download_update,
            update::reveal_update,
            update::open_release_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
