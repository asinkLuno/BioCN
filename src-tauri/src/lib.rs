pub mod library;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            app.manage(library::init(app.handle())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library::library_list,
            library::library_import,
            library::library_remove,
            library::library_cover,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
