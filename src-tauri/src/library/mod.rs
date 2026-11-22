//! Library commands exposed to the frontend.

mod epub;
pub mod store;

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

pub use store::{Book, CoverImage, ImportError, ImportReport, Library};

/// Library root: `<app data>/library`.
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<Library, Box<dyn std::error::Error>> {
    let root = app.path().app_data_dir()?.join("library");
    store::ensure_dirs(&root)?;
    Ok(Library::new(root))
}

/// Opens a picked path through the fs plugin so Android `content://` URIs work.
fn open_picked<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<std::fs::File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    app.fs()
        .open(file_path(path), options)
        .map_err(|error| error.to_string())
}

/// Parses a `content://` / `file://` URI or a plain path. Parsing cannot fail.
/// Decodes the percent-escapes used by URIs, e.g. Android `content://` document ids.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        // Hex digits are ASCII, so decode them from the bytes: slicing the
        // string could split a multi-byte character and panic.
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
        {
            out.push(high << 4 | low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Parses a plain path or a `content://` / `file://` URI. Parsing cannot fail.
/// Export uses it too, so commands write their report files through the same
/// fs-plugin support.
pub(crate) fn file_path(path: &str) -> FilePath {
    match path.parse::<FilePath>() {
        Ok(file_path) => file_path,
        Err(never) => match never {},
    }
}

#[tauri::command]
pub async fn library_list(library: State<'_, Library>) -> Result<Vec<Book>, String> {
    // Reading and parsing the index is disk work; keep it off the IPC thread.
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || library.list())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn library_import<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<String>,
) -> Result<ImportReport, String> {
    // Reading and unpacking EPUBs is slow: keep it off the async runtime workers.
    tauri::async_runtime::spawn_blocking(move || {
        let library = app.state::<Library>().inner().clone();
        let mut added: Vec<Book> = Vec::new();
        let mut errors = Vec::new();

        for path in paths {
            let name = display_name(&path);
            let result = open_picked(&app, &path).and_then(|file| library.import(&name, file));
            match result {
                Ok((book, _)) => {
                    if !added.iter().any(|existing| existing.id == book.id) {
                        added.push(book);
                    }
                }
                Err(message) => errors.push(ImportError { name, message }),
            }
        }

        Ok(ImportReport {
            library: library.list()?,
            added,
            errors,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn library_remove<R: Runtime>(
    app: AppHandle<R>,
    library: State<'_, Library>,
    id: String,
) -> Result<Vec<Book>, String> {
    if let Some(reading) = app.try_state::<crate::reading::ReadingState>() {
        reading.evict(&id);
    }
    if let Some(progress) = app.try_state::<crate::progress::ProgressStore>() {
        progress.remove(&id);
    }
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || library.remove(&id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn library_cover(
    library: State<'_, Library>,
    id: String,
) -> Result<Option<CoverImage>, String> {
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || library.cover(&id))
        .await
        .map_err(|error| error.to_string())
}

/// File name for error messages and as a title fallback.
///
/// Android hands us percent-encoded `content://` URIs whose last segment is the
/// whole document path (`primary%3ABooks%2Fdune.epub`), so those are decoded
/// before the last segment is taken. Plain paths are left untouched because a
/// file name may legitimately contain a `%`.
fn display_name(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    // Strip the query and fragment first: decoding turns `%3F` into a `?` that
    // would otherwise be cut off.
    let trimmed = trimmed.split(['?', '#']).next().unwrap_or(trimmed);
    let last = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    // Only URIs carry escapes; a real file name may legitimately contain a `%`.
    // Decoding can also reveal separators, so take a segment again afterwards.
    let decoded = path.contains("://").then(|| percent_decode(last));
    let last = decoded.as_deref().map_or(last, |decoded| {
        decoded.rsplit(['/', '\\']).next().unwrap_or(decoded)
    });
    if last.is_empty() {
        PathBuf::from(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_owned())
    } else {
        last.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{display_name, file_path};
    use tauri_plugin_fs::FilePath;

    #[test]
    fn display_name_handles_paths_and_uris() {
        assert_eq!(display_name("/home/me/book.epub"), "book.epub");
        assert_eq!(display_name("C:\\books\\book.epub"), "book.epub");
        assert_eq!(display_name("content://com.android/docs/document/1"), "1");
        assert_eq!(display_name("file:///tmp/a%20b.epub"), "a b.epub");
        // Android document URIs encode the whole path in the last segment.
        assert_eq!(
            display_name(
                "content://com.android.externalstorage.documents/document/primary%3ABooks%2Fdune.epub"
            ),
            "dune.epub"
        );
        // The query and fragment are cut before decoding, not after.
        assert_eq!(display_name("file:///tmp/a%20b.epub?x=1"), "a b.epub");
        assert_eq!(
            display_name("content://docs/document/dune%3F.epub"),
            "dune?.epub"
        );
        // A literal `%` in a plain path is not an escape.
        assert_eq!(display_name("/tmp/100% Pure.epub"), "100% Pure.epub");
    }

    #[test]
    fn file_path_keeps_platform_paths_and_uris_apart() {
        // A Windows drive letter has a one-character scheme and must stay a path.
        assert!(matches!(
            file_path(r"C:\books\book.epub"),
            FilePath::Path(_)
        ));
        assert!(matches!(
            file_path("/tmp/book.epub"),
            FilePath::Path(path) if path.file_name().unwrap() == "book.epub"
        ));
        assert!(matches!(
            file_path("content://com.android.providers/document/1"),
            FilePath::Url(_)
        ));
        assert!(matches!(
            file_path("file:///tmp/book.epub"),
            FilePath::Url(_)
        ));
    }
}
