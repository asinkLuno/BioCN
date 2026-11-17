//! On-disk EPUB library.
//!
//! Layout under the app data directory:
//!
//! ```text
//! library/
//!   index.json          list of books (the only mutable state)
//!   files/<id>.epub     immutable copies of imported books
//!   covers/<id>.<ext>   extracted cover images
//! ```
//!
//! Imported files are always copied into `files/` so the library keeps working
//! after a picker URI (Android `content://`) stops being readable.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::epub;

const INDEX_VERSION: u32 = 1;
const MAX_IMPORT_BYTES: u64 = 512 * 1024 * 1024;

/// A book as the UI sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    /// Content hash, also the file name stem.
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    /// Milliseconds since the Unix epoch.
    pub added_at: u64,
    pub size: u64,
    pub has_cover: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub library: Vec<Book>,
    pub added: Vec<Book>,
    pub errors: Vec<ImportError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportError {
    pub name: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverImage {
    pub mime: String,
    pub base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Index {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    books: Vec<Book>,
}

/// Library rooted at `<app data>/library`.
#[derive(Clone)]
pub struct Library {
    root: PathBuf,
    /// Serializes every read-modify-write of `index.json`.
    guard: Arc<Mutex<()>>,
}

impl Library {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            guard: Arc::new(Mutex::new(())),
        }
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }

    fn files_dir(&self) -> PathBuf {
        self.root.join("files")
    }

    fn covers_dir(&self) -> PathBuf {
        self.root.join("covers")
    }

    /// A scratch name that no other import or process can collide with.
    ///
    /// Two app instances can share one library directory, so a fixed
    /// `import.tmp` would let them truncate each other's staging file.
    fn temp_path(&self, kind: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.root
            .join(format!("{kind}-{}-{unique}.tmp", std::process::id()))
    }

    fn book_path(&self, id: &str) -> PathBuf {
        self.files_dir().join(format!("{id}.epub"))
    }

    /// Reads the index.
    ///
    /// A missing file is an empty library; an unreadable or corrupt one is an
    /// error, because saving over it would silently delete every book.
    fn load(&self) -> Result<Index, String> {
        let empty = || Index {
            version: INDEX_VERSION,
            books: Vec::new(),
        };
        match fs::read_to_string(self.index_path()) {
            Ok(text) => serde_json::from_str::<Index>(&text)
                .map_err(|error| format!("书库索引无法读取：{error}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty()),
            Err(error) => Err(format!("无法读取书库索引：{error}")),
        }
    }

    /// Writes the index atomically: a crash leaves either the old or the new file.
    fn save(&self, index: &Index) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let temp = self.temp_path("index");
        let text = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
        let write = (|| {
            let mut file = fs::File::create(&temp)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()
        })();
        if let Err(error) = write {
            let _ = fs::remove_file(&temp);
            return Err(error.to_string());
        }
        fs::rename(&temp, self.index_path()).map_err(|error| {
            let _ = fs::remove_file(&temp);
            error.to_string()
        })
    }

    /// Lists the library, newest first.
    ///
    /// A corrupt index is reported rather than silently shown as an empty shelf.
    pub fn list(&self) -> Result<Vec<Book>, String> {
        Ok(sorted(self.load()?.books))
    }

    /// Copies `source` into the library and indexes it.
    ///
    /// `source` is an already-opened stream so callers can resolve platform
    /// paths themselves (see `mod.rs`), and so a failed read never leaves a
    /// half-copied file behind.
    pub fn import<R: std::io::Read>(
        &self,
        display_name: &str,
        source: R,
    ) -> Result<(Book, Vec<Book>), String> {
        let _guard = self.lock();
        fs::create_dir_all(self.files_dir()).map_err(|e| e.to_string())?;
        fs::create_dir_all(self.covers_dir()).map_err(|e| e.to_string())?;

        let (size, id, staged) = self.stage(source)?;
        let result = self.index_staged(display_name, &staged, &id, size);
        // The staged file was either renamed into place or is no longer needed.
        let _ = fs::remove_file(&staged);
        result
    }

    /// Copies `source` to a scratch file, returning its size, content hash and path.
    ///
    /// Any failure removes the scratch file: importing cannot leave garbage in
    /// the library directory, whatever goes wrong.
    fn stage<R: std::io::Read>(&self, source: R) -> Result<(u64, String, PathBuf), String> {
        let staged = self.temp_path("import");
        let copied = Self::copy_to(source, &staged);
        match copied {
            Ok((size, id)) => Ok((size, id, staged)),
            Err(error) => {
                let _ = fs::remove_file(&staged);
                Err(error)
            }
        }
    }

    fn copy_to<R: std::io::Read>(mut source: R, staged: &Path) -> Result<(u64, String), String> {
        let mut file = fs::File::create(staged).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut size: u64 = 0;
        loop {
            let read = source.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            size += read as u64;
            if size > MAX_IMPORT_BYTES {
                return Err(format!(
                    "file is larger than {} MB",
                    MAX_IMPORT_BYTES / (1024 * 1024)
                ));
            }
            hasher.update(&buffer[..read]);
            file.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
        }
        file.sync_all().map_err(|e| e.to_string())?;
        Ok((size, hex(&hasher.finalize())))
    }

    /// Adds an already staged file to the index, rolling back on failure.
    fn index_staged(
        &self,
        display_name: &str,
        staged: &Path,
        id: &str,
        size: u64,
    ) -> Result<(Book, Vec<Book>), String> {
        let metadata = epub::read_metadata(fs::File::open(staged).map_err(|e| e.to_string())?)
            .map_err(|error| error.to_string())?;

        let mut index = self.load()?;
        index.version = INDEX_VERSION;

        if let Some(existing) = index.books.iter().find(|book| book.id == id) {
            return Ok((existing.clone(), sorted(index.books)));
        }

        let target = self.book_path(id);
        let is_new = !target.exists();
        if is_new {
            fs::rename(staged, &target).map_err(|e| e.to_string())?;
        }

        // A cover that cannot be written is not worth failing the import over:
        // the book is still readable and the tile falls back to a placeholder.
        let cover_path = metadata
            .cover
            .as_ref()
            .and_then(|cover| epub::extension_for_mime(&cover.mime))
            .and_then(|extension| {
                let path = self.covers_dir().join(format!("{id}.{extension}"));
                fs::write(&path, &metadata.cover.as_ref().expect("checked").bytes)
                    .ok()
                    .map(|_| path)
            });

        let book = Book {
            id: id.to_owned(),
            title: metadata
                .title
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| fallback_title(display_name)),
            authors: metadata.authors,
            added_at: now_ms(),
            size,
            has_cover: cover_path.is_some(),
        };
        index.books.push(book.clone());

        if let Err(error) = self.save(&index) {
            // Roll back so the library never holds files the index does not know.
            if is_new {
                let _ = fs::remove_file(self.book_path(id));
            }
            // Only files this call created may be removed; a pre-existing book
            // keeps its cover even if this duplicate's index save failed.
            if let (true, Some(path)) = (is_new, &cover_path) {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }

        Ok((book, sorted(index.books)))
    }

    /// Drops a book from the index and deletes its files.
    ///
    /// The index is saved first so a failed delete can only leave an orphan
    /// file, never an entry pointing at nothing. Ids are content hashes, so an
    /// orphan is reused (and thus healed) if the same book is imported again.
    pub fn remove(&self, id: &str) -> Result<Vec<Book>, String> {
        let _guard = self.lock();
        let mut index = self.load()?;
        index.books.retain(|book| book.id != id);
        self.save(&index)?;

        // Ids come from the frontend, so never let one escape the library dirs.
        if is_valid_id(id) {
            let _ = fs::remove_file(self.book_path(id));
            for extension in epub::COVER_EXTENSIONS {
                let _ = fs::remove_file(self.covers_dir().join(format!("{id}.{extension}")));
            }
        }
        Ok(sorted(index.books))
    }

    pub fn cover(&self, id: &str) -> Option<CoverImage> {
        if !is_valid_id(id) {
            return None;
        }
        for extension in epub::COVER_EXTENSIONS {
            let path = self.covers_dir().join(format!("{id}.{extension}"));
            if let Ok(bytes) = fs::read(&path) {
                return Some(CoverImage {
                    mime: epub::mime_for_extension(extension)
                        .expect("the extension list comes from the same table")
                        .to_owned(),
                    base64: base64_encode(&bytes),
                });
            }
        }
        None
    }

    /// Path of the stored book file. Kept for the reader, not the UI.
    pub fn book_file(&self, id: &str) -> Option<PathBuf> {
        // Ids arrive from the frontend, so never let one escape `files/`.
        if !is_valid_id(id) {
            return None;
        }
        let path = self.book_path(id);
        path.exists().then_some(path)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.guard
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

/// Newest first; ties are broken by title, then id, so the order is stable.
fn sorted(mut books: Vec<Book>) -> Vec<Book> {
    books.sort_by(|a, b| {
        b.added_at
            .cmp(&a.added_at)
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.id.cmp(&b.id))
    });
    books
}

/// Book ids are SHA-256 hex digests; anything else is not a book we stored.
fn is_valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Title used when the OPF has none: the file name without its extension.
fn fallback_title(display_name: &str) -> String {
    let name = display_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(display_name);
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let stem = stem.trim();
    if stem.is_empty() {
        crate::reading::DEFAULT_TITLE.to_owned()
    } else {
        stem.to_owned()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Ensures the library directories exist.
pub fn ensure_dirs(root: &Path) -> std::io::Result<()> {
    fs::create_dir_all(root.join("files"))?;
    fs::create_dir_all(root.join("covers"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn temp_files(root: &Path) -> Vec<String> {
        fs::read_dir(root)
            .unwrap()
            .filter_map(|entry| {
                let name = entry.ok()?.file_name().to_string_lossy().into_owned();
                name.ends_with(".tmp").then_some(name)
            })
            .collect()
    }

    fn library() -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        ensure_dirs(dir.path()).unwrap();
        let library = Library::new(dir.path().to_path_buf());
        (dir, library)
    }

    fn epub_bytes_with_title(extra_opf_item: &str, title: Option<&str>) -> Vec<u8> {
        use zip::ZipWriter;
        use zip::write::SimpleFileOptions;
        let title = title
            .map(|title| format!("<dc:title>{title}</dc:title>"))
            .unwrap_or_default();
        let opf = format!(
            r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
              <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                {title}<dc:creator>Frank Herbert</dc:creator>
              </metadata>
              <manifest>{extra_opf_item}</manifest>
            </package>"#
        );
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        writer
            .start_file("META-INF/container.xml", options)
            .unwrap();
        writer
            .write_all(
                br#"<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
            )
            .unwrap();
        writer.start_file("OEBPS/content.opf", options).unwrap();
        writer.write_all(opf.as_bytes()).unwrap();
        if !extra_opf_item.is_empty() {
            writer.start_file("OEBPS/c.png", options).unwrap();
            writer.write_all(b"png bytes").unwrap();
        }
        let cursor = writer.finish().unwrap();
        cursor.into_inner()
    }

    fn epub_bytes(extra_opf_item: &str) -> Vec<u8> {
        epub_bytes_with_title(extra_opf_item, Some("Dune"))
    }

    #[test]
    fn import_stores_book_and_cover() {
        let (dir, library) = library();
        let bytes = epub_bytes(
            r#"<item id="c" href="c.png" media-type="image/png" properties="cover-image"/>"#,
        );
        let (book, books) = library
            .import("Dune.epub", Cursor::new(bytes))
            .expect("import succeeds");

        assert_eq!(book.title, "Dune");
        assert_eq!(book.authors, vec!["Frank Herbert"]);
        assert!(book.has_cover);
        assert_eq!(books.len(), 1);
        assert!(library.book_file(&book.id).is_some());

        let cover = library.cover(&book.id).expect("cover stored");
        assert_eq!(cover.mime, "image/png");
        assert_eq!(cover.base64, "cG5nIGJ5dGVz");

        // Index is durable: a fresh handle sees the same book.
        let reopened = Library::new(dir.path().to_path_buf());
        assert_eq!(reopened.list().unwrap().len(), 1);
    }

    #[test]
    fn import_is_idempotent() {
        let (_dir, library) = library();
        let bytes = epub_bytes("");
        let (first, _) = library
            .import("a.epub", Cursor::new(bytes.clone()))
            .unwrap();
        let (second, books) = library.import("a.epub", Cursor::new(bytes)).unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(books.len(), 1, "importing the same file twice adds it once");
    }

    #[test]
    fn import_rejects_non_epub_and_keeps_library_clean() {
        let (dir, library) = library();
        let error = library
            .import("broken.epub", Cursor::new(b"garbage".to_vec()))
            .unwrap_err();

        assert!(error.contains("EPUB"), "unexpected error: {error}");
        assert!(library.list().unwrap().is_empty());
        assert!(
            temp_files(dir.path()).is_empty(),
            "no staging file is left behind"
        );
    }

    #[test]
    fn concurrent_imports_do_not_share_a_staging_file() {
        let (_dir, library) = library();
        let first = epub_bytes_with_title("", Some("First"));
        let second = epub_bytes_with_title("", Some("Second"));

        let threads: Vec<_> = [first, second]
            .into_iter()
            .map(|bytes| {
                let library = library.clone();
                std::thread::spawn(move || library.import("book.epub", Cursor::new(bytes)).unwrap())
            })
            .collect();
        let mut titles: Vec<String> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap().0.title)
            .collect();
        titles.sort();

        assert_eq!(titles, vec!["First", "Second"]);
        assert_eq!(library.list().unwrap().len(), 2);
    }

    #[test]
    fn falls_back_to_file_name_without_title() {
        let (_dir, library) = library();
        let bytes = epub_bytes_with_title("", None);
        let (book, _) = library
            .import("Some File.epub", Cursor::new(bytes))
            .unwrap();
        assert_eq!(book.title, "Some File");
    }

    #[test]
    fn refuses_to_overwrite_a_corrupt_index() {
        let (dir, library) = library();
        fs::write(dir.path().join("index.json"), "{ not json").unwrap();

        let error = library
            .import("a.epub", Cursor::new(epub_bytes("")))
            .unwrap_err();

        assert!(error.contains("无法读取"), "意外的错误：{error}");
        assert_eq!(
            fs::read_to_string(dir.path().join("index.json")).unwrap(),
            "{ not json",
            "the user's index is left untouched"
        );
        assert_eq!(fs::read_dir(dir.path().join("files")).unwrap().count(), 0);
        assert!(temp_files(dir.path()).is_empty());
        assert!(library.list().is_err());
    }

    #[test]
    fn import_drops_a_cover_it_could_not_write() {
        use std::os::unix::fs::PermissionsExt as _;

        let (_dir, library) = library();
        // A read-only covers directory makes only the cover write fail.
        let covers = library.covers_dir();
        fs::set_permissions(&covers, fs::Permissions::from_mode(0o555)).unwrap();

        let bytes = epub_bytes(
            r#"<item id="c" href="c.png" media-type="image/png" properties="cover-image"/>"#,
        );
        let (book, _) = library.import("a.epub", Cursor::new(bytes)).unwrap();

        fs::set_permissions(&covers, fs::Permissions::from_mode(0o755)).unwrap();

        assert!(
            !book.has_cover,
            "no cover was stored, so none is advertised"
        );
        assert!(library.cover(&book.id).is_none());
    }

    #[test]
    fn rejects_ids_that_could_escape_the_library() {
        let (dir, library) = library();
        let outside = dir.path().join("secret.jpg");
        fs::write(&outside, b"keep me").unwrap();

        assert!(library.cover("../../secret").is_none());
        library.remove("../../secret").unwrap();
        assert!(outside.exists(), "nothing outside the cover dir is touched");
    }

    #[test]
    fn remove_deletes_index_entry_and_files() {
        let (dir, library) = library();
        let (book, _) = library
            .import("a.epub", Cursor::new(epub_bytes("")))
            .unwrap();
        let books = library.remove(&book.id).unwrap();

        assert!(books.is_empty());
        assert!(library.book_file(&book.id).is_none());
        assert!(
            !dir.path()
                .join("covers")
                .join(format!("{}.jpg", book.id))
                .exists()
        );
    }
}
