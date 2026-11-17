pub mod analysis;
pub mod analyzer;
pub mod library;
pub mod models;
pub mod reader;
pub mod reading;
pub mod settings;
pub mod text;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            app.manage(library::init(app.handle())?);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
