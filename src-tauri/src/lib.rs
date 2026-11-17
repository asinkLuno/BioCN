pub mod analysis;
pub mod analyzer;
pub mod cache;
pub mod export;
pub mod library;
pub mod models;
pub mod reader;
pub mod reading;
pub mod settings;
pub mod text;

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
        .setup(|app| {
            app.manage(library::init(app.handle())?);
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
            reading::book_chapter,
            analyzer::colorize_book,
            analyzer::coloring_progress,
            analyzer::colorize_book_cancel,
            analyzer::clear_book_cache,
            export::export_book,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
