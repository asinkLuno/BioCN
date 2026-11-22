//! Per-book reading position, persisted atomically under `<app data>/library/progress.json`.
//!
//! Stored separately from `analysis.db` because reading position is user state
//! (losing it on cache rebuild would send every book back to chapter 1).
//! Each entry stores both the chapter index, the first visible paragraph anchor
//! (`data-bp`) and the scroll/page ratio inside the chapter so restoring works
//! cleanly even after font size, window size, or scrolled↔paginated switches.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

const FILE: &str = "progress.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingProgress {
    pub chapter_index: usize,
    /// Paragraph anchor (`data-bp`) nearest the top of the viewport, if any.
    #[serde(default)]
    pub paragraph_index: Option<usize>,
    /// Normalized position within the chapter (`0.0..=1.0`).
    #[serde(default)]
    pub ratio: f64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProgressFile {
    #[serde(default)]
    books: HashMap<String, ReadingProgress>,
}

#[derive(Clone)]
pub struct ProgressStore {
    path: PathBuf,
    guard: Arc<Mutex<()>>,
}

impl ProgressStore {
    pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<Self, Box<dyn std::error::Error>> {
        let dir = app.path().app_data_dir()?.join("library");
        fs::create_dir_all(&dir)?;
        Ok(Self::new(dir.join(FILE)))
    }

    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            guard: Arc::new(Mutex::new(())),
        }
    }

    pub fn get(&self, book_id: &str) -> Option<ReadingProgress> {
        let _lock = self.lock();
        self.load().books.remove(book_id)
    }

    pub fn save(&self, book_id: &str, mut progress: ReadingProgress) -> Result<(), String> {
        let _lock = self.lock();
        progress.ratio = progress.ratio.clamp(0.0, 1.0);
        if progress.updated_at == 0 {
            progress.updated_at = now_ms();
        }
        let mut data = self.load();
        data.books.insert(book_id.to_owned(), progress);
        self.write(&data)
    }

    pub fn remove(&self, book_id: &str) {
        let _lock = self.lock();
        let mut data = self.load();
        if data.books.remove(book_id).is_some() {
            let _ = self.write(&data);
        }
    }

    fn load(&self) -> ProgressFile {
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn write(&self, data: &ProgressFile) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = self
            .path
            .with_extension(format!("json.{}.{}.tmp", std::process::id(), unique));
        fs::write(&tmp, text).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            e.to_string()
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.guard
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn book_progress_get(
    store: State<'_, ProgressStore>,
    id: String,
) -> Result<Option<ReadingProgress>, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.get(&id))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn book_progress_save(
    store: State<'_, ProgressStore>,
    id: String,
    chapter_index: usize,
    paragraph_index: Option<usize>,
    ratio: f64,
) -> Result<(), String> {
    let store = store.inner().clone();
    let progress = ReadingProgress {
        chapter_index,
        paragraph_index,
        ratio,
        updated_at: now_ms(),
    };
    tauri::async_runtime::spawn_blocking(move || store.save(&id, progress))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_loads_clamps_and_removes_progress() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProgressStore::new(dir.path().join("progress.json"));
        assert!(store.get("dune").is_none());

        store
            .save(
                "dune",
                ReadingProgress {
                    chapter_index: 4,
                    paragraph_index: Some(12),
                    ratio: 1.5,
                    updated_at: 0,
                },
            )
            .unwrap();
        let loaded = store.get("dune").expect("saved");
        assert_eq!(loaded.chapter_index, 4);
        assert_eq!(loaded.paragraph_index, Some(12));
        assert_eq!(loaded.ratio, 1.0);
        assert!(loaded.updated_at > 0);

        store.remove("dune");
        assert!(store.get("dune").is_none());
    }

    #[test]
    fn malformed_file_falls_back_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("progress.json");
        fs::write(&file, "{broken").unwrap();
        let store = ProgressStore::new(file);
        assert!(store.get("dune").is_none());
    }
}
