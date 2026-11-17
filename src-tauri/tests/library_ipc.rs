//! End-to-end check of the `library_*` commands through Tauri's IPC layer.
//!
//! This exercises the real `#[tauri::command]` plumbing: argument decoding,
//! opening the picked path through the fs plugin, and the JSON the UI receives.

use biocn_lib::library::{self, Library};
use serde_json::json;
use tauri::WebviewWindowBuilder;
use tauri::test::{INVOKE_KEY, mock_builder};
use tauri::webview::InvokeRequest;

fn epub_bytes(title: &str) -> Vec<u8> {
    use std::io::{Cursor, Write as _};
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default();
    writer.start_file("mimetype", options).unwrap();
    writer.write_all(b"application/epub+zip").unwrap();
    writer
        .start_file("META-INF/container.xml", options)
        .unwrap();
    writer
        .write_all(
            br#"<container><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
        )
        .unwrap();
    writer.start_file("content.opf", options).unwrap();
    writer
        .write_all(
            format!(
                r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
                     <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                       <dc:title>{title}</dc:title>
                       <dc:creator>Frank Herbert</dc:creator>
                     </metadata>
                     <manifest/>
                   </package>"#
            )
            .as_bytes(),
        )
        .unwrap();
    writer.finish().unwrap().into_inner()
}

fn call(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: serde_json::Value,
) -> serde_json::Value {
    let response = tauri::test::get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .expect("command succeeds");

    response.deserialize::<serde_json::Value>().unwrap()
}

#[test]
fn commands_import_list_and_remove_a_book() {
    let dir = tempfile::tempdir().unwrap();
    library::store::ensure_dirs(dir.path()).unwrap();
    let book_path = dir.path().join("Dune.epub");
    std::fs::write(&book_path, epub_bytes("Dune")).unwrap();

    let app = mock_builder()
        .plugin(tauri_plugin_fs::init())
        .manage(Library::new(dir.path().join("library")))
        .invoke_handler(tauri::generate_handler![
            library::library_list,
            library::library_import,
            library::library_remove,
            library::library_cover,
        ])
        // The real context brings the app capabilities, so the ACL check is exercised.
        .build(tauri::generate_context!())
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert_eq!(call(&webview, "library_list", json!({})), json!([]));

    let report = call(
        &webview,
        "library_import",
        json!({ "paths": [book_path.to_string_lossy()] }),
    );
    assert_eq!(report["errors"], json!([]));
    assert_eq!(report["added"][0]["title"], "Dune");
    assert_eq!(report["added"][0]["authors"], json!(["Frank Herbert"]));
    assert_eq!(report["added"][0]["hasCover"], false);

    let id = report["added"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        call(&webview, "library_list", json!({})),
        report["library"],
        "the index reports the imported book"
    );

    assert_eq!(
        call(&webview, "library_cover", json!({ "id": id })),
        json!(null)
    );

    let after = call(&webview, "library_remove", json!({ "id": id }));
    assert_eq!(after, json!([]));
}

#[test]
fn import_reports_unreadable_files_without_failing_the_batch() {
    let dir = tempfile::tempdir().unwrap();
    library::store::ensure_dirs(dir.path()).unwrap();
    let good = dir.path().join("good.epub");
    let bad = dir.path().join("bad.epub");
    std::fs::write(&good, epub_bytes("Good")).unwrap();
    std::fs::write(&bad, b"not a zip").unwrap();

    let app = mock_builder()
        .plugin(tauri_plugin_fs::init())
        .manage(Library::new(dir.path().join("library")))
        .invoke_handler(tauri::generate_handler![
            library::library_list,
            library::library_import,
            library::library_remove,
            library::library_cover,
        ])
        // The real context brings the app capabilities, so the ACL check is exercised.
        .build(tauri::generate_context!())
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let paths: Vec<String> = [bad, good]
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let report = call(&webview, "library_import", json!({ "paths": paths }));

    assert_eq!(report["added"].as_array().unwrap().len(), 1);
    assert_eq!(report["added"][0]["title"], "Good");
    assert_eq!(report["errors"][0]["name"], "bad.epub");
    assert!(
        report["errors"][0]["message"]
            .as_str()
            .unwrap()
            .contains("EPUB"),
        "unexpected message: {}",
        report["errors"][0]["message"]
    );

    // A path outside the library is simply reported, never fatal.
    let missing = call(
        &webview,
        "library_import",
        json!({ "paths": ["/does/not/exist.epub"] }),
    );
    assert_eq!(missing["errors"].as_array().unwrap().len(), 1);
    assert_eq!(missing["library"].as_array().unwrap().len(), 1);
}
