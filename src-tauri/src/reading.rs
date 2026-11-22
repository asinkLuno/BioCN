//! Reading a book from the shelf: lazy EPUB indexing, per-chapter parsing, and
//! on-demand resource access for the `book://` protocol.
//!
//! Opening a book reads only the OPF/TOC/spine (milliseconds) and keeps one
//! [`BookHandle`] open for the active book so chapters and resources (images,
//! CSS, fonts) are read on demand without re-parsing the zip directory or
//! holding every chapter's parsed text in memory.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::cache::AnalysisCache;
use crate::library::Library;
use crate::progress::{ProgressStore, ReadingProgress};
use crate::reader::{BookHandle, BookIndex, Chapter, TocEntry};

type Result<T> = std::result::Result<T, String>;

/// Maximum parsed chapters kept in RAM per open book (HTML + char-level source
/// maps). Large enough for back-and-forth reading and next-chapter prefetch,
/// bounded so reading a 500-chapter novel does not grow RAM indefinitely.
#[cfg(target_os = "android")]
const MAX_CACHED_CHAPTERS: usize = 8;
#[cfg(not(target_os = "android"))]
const MAX_CACHED_CHAPTERS: usize = 16;

/// Small LRU cache of parsed chapters keyed by spine index.
struct ChapterLru {
    cap: usize,
    /// Ordered oldest -> most recently used.
    entries: Vec<(usize, Arc<Chapter>)>,
}

impl ChapterLru {
    fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            entries: Vec::with_capacity(cap.max(1)),
        }
    }

    fn get(&mut self, index: usize) -> Option<Arc<Chapter>> {
        let pos = self.entries.iter().position(|(k, _)| *k == index)?;
        let entry = self.entries.remove(pos);
        let value = entry.1.clone();
        self.entries.push(entry);
        Some(value)
    }

    fn insert(&mut self, index: usize, chapter: Arc<Chapter>) -> Arc<Chapter> {
        if let Some(existing) = self.get(index) {
            return existing;
        }
        if self.entries.len() >= self.cap {
            self.entries.remove(0);
        }
        self.entries.push((index, chapter.clone()));
        chapter
    }
}

/// Shown when a book has no usable title anywhere (OPF and file name both
/// empty). One shared constant so the fallback word cannot drift between the
/// reader, the coloring job and the index.
pub(crate) const DEFAULT_TITLE: &str = "无题";

/// An open book kept ready for chapter/resource reads.
pub struct ActiveBook {
    pub id: String,
    handle: Mutex<BookHandle>,
    pub index: BookIndex,
    chapters: Mutex<ChapterLru>,
}

impl ActiveBook {
    fn open(id: String, path: &std::path::Path) -> Result<Self> {
        let handle = BookHandle::open(path).map_err(|e| e.to_string())?;
        let index = handle.index.clone();
        Ok(Self {
            id,
            handle: Mutex::new(handle),
            index,
            chapters: Mutex::new(ChapterLru::new(MAX_CACHED_CHAPTERS)),
        })
    }

    /// Parses and caches a single spine chapter on demand (bounded LRU).
    pub fn chapter(&self, index: usize) -> Result<Arc<Chapter>> {
        if let Some(cached) = self
            .chapters
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(index)
        {
            return Ok(cached);
        }
        let parsed = {
            let handle = self.handle.lock().unwrap_or_else(|p| p.into_inner());
            Arc::new(handle.read_chapter(index).map_err(|e| e.to_string())?)
        };
        let mut cache = self.chapters.lock().unwrap_or_else(|p| p.into_inner());
        Ok(cache.insert(index, parsed))
    }

    /// Resolves a normalized container path to its spine chapter, if it is one.
    pub fn chapter_by_href(&self, container_path: &str) -> Result<Option<Arc<Chapter>>> {
        let Some(norm) = crate::reader::normalize_container_path(container_path) else {
            return Ok(None);
        };
        let Some(&index) = self.index.by_href.get(&norm) else {
            return Ok(None);
        };
        self.chapter(index).map(Some)
    }

    /// Reads any raw resource (image, CSS, font, SVG, ...) from the open EPUB.
    pub fn read_resource(&self, container_path: &str) -> Result<Option<(Vec<u8>, String)>> {
        let handle = self.handle.lock().unwrap_or_else(|p| p.into_inner());
        handle
            .read_resource(container_path)
            .map_err(|e| e.to_string())
    }
}

#[derive(Default)]
pub struct ReadingState {
    active: Mutex<Option<Arc<ActiveBook>>>,
    /// Serializes opening a book so concurrent calls don't parse the same OPF twice.
    opening: Mutex<()>,
    /// Full-book parse cache used only by whole-book coloring and cache clear.
    full_book: Mutex<Option<(String, Arc<Vec<Chapter>>)>>,
    full_parsing: Mutex<()>,
}

impl ReadingState {
    /// Drops any open handles for `id` (required on Windows before deleting the EPUB).
    pub fn evict(&self, id: &str) {
        if let Ok(mut active) = self.active.lock()
            && active.as_ref().is_some_and(|book| book.id == id)
        {
            *active = None;
        }
        self.clear_full_book(id);
    }

    /// Releases the full-book parsed chapter cache for `id` once a whole-book
    /// coloring or cache-clear pass completes so tens of MB of parsed XHTML and
    /// character source maps do not stay resident indefinitely.
    pub fn clear_full_book(&self, id: &str) {
        if let Ok(mut full) = self.full_book.lock()
            && full.as_ref().is_some_and(|(cached_id, _)| cached_id == id)
        {
            *full = None;
        }
    }

    /// Returns the open [`ActiveBook`] for `id`, opening it once if needed.
    pub fn open_sync<R: Runtime>(&self, app: &AppHandle<R>, id: &str) -> Result<Arc<ActiveBook>> {
        if let Some(book) = self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .filter(|book| book.id == id)
            .cloned()
        {
            return Ok(book);
        }
        let _gate = self.opening.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(book) = self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .filter(|book| book.id == id)
            .cloned()
        {
            return Ok(book);
        }
        let library = app.state::<Library>();
        let path = library
            .book_file(id)
            .ok_or_else(|| format!("book-missing: 书库里没有这本书（{id}）"))?;
        let opened = Arc::new(ActiveBook::open(id.to_owned(), &path)?);
        *self.active.lock().unwrap_or_else(|p| p.into_inner()) = Some(opened.clone());
        Ok(opened)
    }

    /// Returns the spine chapter indices for `id`, reusing the already-open
    /// `ActiveBook` or `full_book` cache if present, otherwise reading only the
    /// OPF spine without replacing `active` or unzipping chapter XHTML.
    pub fn spine_indices_sync<R: Runtime>(&self, app: &AppHandle<R>, id: &str) -> Result<Vec<usize>> {
        if let Some(book) = self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .filter(|book| book.id == id)
            .cloned()
        {
            return Ok(book.index.spine.iter().map(|s| s.index).collect());
        }
        if let Some(chapters) = self
            .full_book
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .filter(|(cached_id, _)| cached_id == id)
            .map(|(_, chs)| chs.clone())
        {
            return Ok(chapters.iter().map(|c| c.index).collect());
        }
        let library = app.state::<Library>();
        let path = library
            .book_file(id)
            .ok_or_else(|| format!("book-missing: 书库里没有这本书（{id}）"))?;
        crate::reader::spine_indices(&path).map_err(|e| e.to_string())
    }
}

/// One spine entry for navigation and progress display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterSummary {
    pub index: usize,
    pub manifest_id: String,
    /// Container path inside the EPUB (without leading `/`), used to build `book://` URLs.
    pub href: String,
    pub title: Option<String>,
    /// Whether this chapter is already marked fully colored under active weights.
    pub colored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookView {
    pub id: String,
    pub title: String,
    pub chapters: Vec<ChapterSummary>,
    pub toc: Vec<TocEntry>,
    /// Chapter to open first: saved progress if valid, else first chapter with prose.
    pub initial_chapter: Option<usize>,
    /// Last saved reading position, if any.
    pub progress: Option<ReadingProgress>,
    /// Whether an analysis model is currently installed.
    pub has_model: bool,
}

/// Immediate chapter status returned when requesting progressive coloring.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterColorState {
    pub index: usize,
    pub total_sentences: usize,
    pub cached_sentences: usize,
    pub fully_colored: bool,
    pub missing_model: bool,
}

/// Opens (or reuses) the [`ActiveBook`] off the async worker pool.
pub async fn open_book<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<Arc<ActiveBook>> {
    let app = app.clone();
    let id = id.to_owned();
    tauri::async_runtime::spawn_blocking(move || app.state::<ReadingState>().open_sync(&app, &id))
        .await
        .map_err(|e| e.to_string())?
}

/// Parses one chapter on demand (cached on the active book).
pub async fn get_chapter<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    index: usize,
) -> Result<Arc<Chapter>> {
    let app = app.clone();
    let id = id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let active = app.state::<ReadingState>().open_sync(&app, &id)?;
        active.chapter(index)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every chapter of `id`, parsed (from memory when it is the cached book).
///
/// Used by whole-book coloring and cache clearing, which genuinely need all
/// chapters' sentences.
pub async fn parse_book<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<Arc<Vec<Chapter>>> {
    let app = app.clone();
    let id = id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ReadingState>();
        if let Ok(cache) = state.full_book.lock()
            && let Some((cached_id, chapters)) = cache.as_ref()
            && cached_id == &id
        {
            return Ok(chapters.clone());
        }
        let _gate = state.full_parsing.lock().unwrap_or_else(|p| p.into_inner());
        if let Ok(cache) = state.full_book.lock()
            && let Some((cached_id, chapters)) = cache.as_ref()
            && cached_id == &id
        {
            return Ok(chapters.clone());
        }
        let library = app.state::<Library>();
        let path = library
            .book_file(&id)
            .ok_or_else(|| format!("book-missing: 书库里没有这本书（{id}）"))?;
        let file = std::fs::File::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let parsed = Arc::new(crate::reader::chapters(file).map_err(|e| e.to_string())?);
        if let Ok(mut cache) = state.full_book.lock() {
            *cache = Some((id, parsed.clone()));
        }
        Ok(parsed)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn title_of<R: Runtime>(app: &AppHandle<R>, id: &str) -> String {
    app.state::<Library>()
        .list()
        .ok()
        .and_then(|books| books.into_iter().find(|book| book.id == id))
        .map(|book| book.title)
        .unwrap_or_else(|| DEFAULT_TITLE.into())
}

/// Opens a book: its title, spine list, nested TOC, saved progress, and
/// initial chapter.
///
/// Never blocks on whole-book coloring and never requires an installed model:
/// reading always opens immediately, and coloring layers on top.
#[tauri::command]
pub async fn book_open<R: Runtime>(app: AppHandle<R>, id: String) -> Result<BookView> {
    let active = open_book(&app, &id).await?;
    let progress = {
        let store = app.state::<ProgressStore>().inner().clone();
        let id = id.clone();
        tauri::async_runtime::spawn_blocking(move || store.get(&id))
            .await
            .map_err(|e| e.to_string())?
    };

    let (has_model, colored_set): (bool, HashSet<usize>) = match crate::cache::weights(&app) {
        Ok(weights) => {
            let cache = app.state::<AnalysisCache>().inner().clone();
            let id = id.clone();
            let set = tauri::async_runtime::spawn_blocking(move || {
                cache.colored_chapters(&weights, &id)
            })
            .await
            .map_err(|e| e.to_string())??;
            (true, set)
        }
        Err(_) => (false, HashSet::new()),
    };

    let initial_chapter = {
        let saved_valid = progress
            .as_ref()
            .map(|p| p.chapter_index)
            .filter(|idx| active.index.spine.iter().any(|s| s.index == *idx));
        if saved_valid.is_some() {
            saved_valid
        } else {
            // Lazily scan only the leading spine entries until we find one with prose
            // (typically index 0, 1, or 2 — skipping cover/title pages without parsing
            // the whole book).
            let active = active.clone();
            tauri::async_runtime::spawn_blocking(move || {
                for entry in active.index.spine.iter().take(12) {
                    if let Ok(ch) = active.chapter(entry.index)
                        && !ch.paragraphs.is_empty()
                    {
                        return Some(entry.index);
                    }
                }
                active.index.spine.first().map(|s| s.index)
            })
            .await
            .map_err(|e| e.to_string())?
        }
    };

    let chapters = active
        .index
        .spine
        .iter()
        .map(|entry| ChapterSummary {
            index: entry.index,
            manifest_id: entry.manifest_id.clone(),
            href: entry.href.clone(),
            title: entry.title.clone(),
            colored: colored_set.contains(&entry.index),
        })
        .collect();

    Ok(BookView {
        title: title_of(&app, &id),
        chapters,
        toc: active.index.toc.clone(),
        initial_chapter,
        progress,
        has_model,
        id,
    })
}

/// Ensures coloring is started (priority P0) for the chapter currently on screen.
///
/// Returns immediately with the chapter's cache status; any missing sentences
/// are analyzed asynchronously and streamed as `chapter://color-patch` events.
#[tauri::command]
pub async fn book_chapter_colorize<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    index: usize,
) -> Result<ChapterColorState> {
    app.state::<crate::analyzer::AnalyzerState>()
        .start_chapter_stream(&app, id, index)
        .await
}

/// Quietly prefetches (priority P1) coloring for an upcoming chapter (usually `index + 1`).
#[tauri::command]
pub async fn book_chapter_prefetch<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    index: usize,
) -> Result<()> {
    app.state::<crate::analyzer::AnalyzerState>()
        .start_prefetch(&app, id, index)
        .await;
    Ok(())
}

/// Cancels any active reader chapter coloring / prefetch stream (e.g. when closing the reader).
#[tauri::command]
pub async fn book_chapter_cancel_stream<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.state::<crate::analyzer::AnalyzerState>().cancel_reader_streams();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chapter_summary_carries_href_without_text() {
        let summary = ChapterSummary {
            index: 3,
            manifest_id: "part-three".into(),
            href: "OEBPS/Text/ch3.xhtml".into(),
            title: Some("第三章".into()),
            colored: true,
        };
        let json = serde_json::to_string(&summary).expect("serialize");
        assert!(json.contains("\"href\":\"OEBPS/Text/ch3.xhtml\""), "{json}");
        assert!(json.contains("\"colored\":true"), "{json}");
    }

    #[test]
    fn chapter_lru_evicts_least_recently_used_entry() {
        let dummy = |index: usize| {
            Arc::new(Chapter {
                index,
                manifest_id: String::new(),
                title: None,
                html: String::new(),
                paragraphs: Vec::new(),
            })
        };
        let mut lru = ChapterLru::new(2);
        lru.insert(0, dummy(0));
        lru.insert(1, dummy(1));
        // Touch 0 so 1 becomes least recently used.
        assert_eq!(lru.get(0).unwrap().index, 0);
        lru.insert(2, dummy(2));

        assert!(lru.get(1).is_none(), "least recently used chapter should be evicted");
        assert_eq!(lru.get(0).unwrap().index, 0);
        assert_eq!(lru.get(2).unwrap().index, 2);
    }
}
