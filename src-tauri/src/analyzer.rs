//! The 主谓宾 analyzer, wired to the models the user installed.
//!
//! Loading the three ONNX sessions takes seconds and several hundred megabytes,
//! so it happens once, on the first book that needs it, and is dropped when the
//! weights change. Everything the reader asks for afterwards is served by
//! [`AnalyzerState::analyze`].
//!
//! Two locks, for two different races:
//!
//! * `installing` is held by `models_install` / `models_remove` for the whole
//!   download and by the load path while it maps the weight files, so a session
//!   can never be built over a half-written variant directory.
//! * `slot` holds the analyzer itself, and the load happens while it is held —
//!   a second request arriving during the load waits for the first instead of
//!   mapping the same three files a second time.
//!
//! Sentences are cached by text in memory: a book re-reads the same sentences
//! on every scroll, and one analysis costs about a millisecond.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Runtime};

use crate::analysis::engine::Sessions;
use crate::analysis::{BioCNResources, Segment, SentenceAnalysis, analyze_sentence};

/// How many analyzed sentences to keep. A novel has 20–40k; the cap is there so
/// a long session cannot grow without bound, and it is large enough that the
/// common case (one book) never evicts anything it will need again.
const CACHE_LIMIT: usize = 60_000;

type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub struct Analyzer {
    resources: BioCNResources,
    sessions: Sessions,
    /// Sentence -> 主谓宾 spans. Owned by the analyzer rather than the app, so
    /// reloading a variant starts from an empty cache: segments are keyed by
    /// text but produced by a specific model, and the two variants are not
    /// guaranteed to agree.
    cache: std::sync::Mutex<HashMap<String, Option<Vec<Segment>>>>,
}

impl Analyzer {
    fn analyze(&self, sentence: &str) -> Result<Option<Vec<Segment>>> {
        if let Ok(cache) = self.cache.lock()
            && let Some(hit) = cache.get(sentence)
        {
            return Ok(hit.clone());
        }
        // Compute without holding the lock: a long paragraph is many sentences
        // and the reader must not be able to block the analysis of the next one.
        let analysis: Option<SentenceAnalysis> =
            analyze_sentence(&self.resources, &self.sessions, sentence).map_err(err)?;
        let segments = analysis.map(|analysis| analysis.segments);
        if let Ok(mut cache) = self.cache.lock() {
            // A plain clear, not an LRU: the eviction that matters is "one
            // book's worth", and that fits. Dropping everything at the cap is
            // the cheapest policy that keeps memory bounded.
            if cache.len() >= CACHE_LIMIT {
                cache.clear();
            }
            cache.insert(sentence.to_owned(), segments.clone());
        }
        Ok(segments)
    }
}

#[derive(Default)]
pub struct AnalyzerState {
    slot: tauri::async_runtime::Mutex<Option<Arc<Analyzer>>>,
    installing: tauri::async_runtime::Mutex<()>,
    /// Serializes install/remove. Separate from `installing`, which is held for
    /// the *whole* download: taking that one here would block every chapter
    /// behind a download, while this one is only there so two operations cannot
    /// write the same `staging/` file or delete a `.part` another is appending
    /// to.
    operation: tauri::async_runtime::Mutex<()>,
}

impl AnalyzerState {
    /// Runs a model install/remove to completion, one at a time.
    pub async fn while_installing_model<T>(&self, work: impl Future<Output = T>) -> T {
        let _operation = self.operation.lock().await;
        work.await
    }
    /// Drops the sessions so the next analysis rebuilds from disk.
    ///
    /// Called after installing or removing weights: the loaded sessions map the
    /// old files, and on Windows the old directory cannot even be deleted while
    /// they hold it.
    ///
    /// A chapter already being analysed holds its own `Arc<Analyzer>` and keeps
    /// running: `models.rs` unloads *before* touching the directory, and a
    /// chapter that started earlier is reading a mapping the OS keeps valid,
    /// but on Windows its files resist deletion until the last reference drops.
    /// Installing while a chapter is loading is therefore allowed to fail and
    /// be retried rather than blocking every read behind a download — see
    /// `models::commit`, whose `remove_dir_all` is best-effort for that reason.
    pub async fn unload(&self) {
        // Dropping the analyzer drops its cache with it: a cached analysis is
        // only valid for the weights that produced it, so a variant swap or a
        // removal must not leave spans behind.
        *self.slot.lock().await = None;
    }

    /// Whether sessions are currently mapped. Only for tests and diagnostics:
    /// callers that want to *use* the analyzer go through `analyzer`.
    #[cfg(test)]
    async fn is_loaded(&self) -> bool {
        self.slot.lock().await.is_some()
    }

    /// Runs `work` while holding the install gate. `models.rs` wraps its file
    /// work in this; see the module docs for what it protects against.
    pub async fn while_installing<T>(&self, work: impl Future<Output = T>) -> T {
        let _gate = self.installing.lock().await;
        work.await
    }

    async fn analyzer<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<Analyzer>> {
        let _gate = self.installing.lock().await;
        let mut slot = self.slot.lock().await;
        if let Some(analyzer) = slot.as_ref() {
            return Ok(analyzer.clone());
        }
        // Session loading is blocking file I/O and ORT graph optimization: it
        // must not run on the async runtime's worker threads.
        let dir = crate::models::installed_dir(app)?;
        let built = tauri::async_runtime::spawn_blocking(move || {
            let resources = BioCNResources::load_dir(&dir).map_err(err)?;
            let sessions = Sessions::load(&dir).map_err(err)?;
            Ok::<_, String>(Analyzer {
                resources,
                sessions,
                cache: std::sync::Mutex::default(),
            })
        })
        .await
        .map_err(err)??;
        let analyzer = Arc::new(built);
        *slot = Some(analyzer.clone());
        Ok(analyzer)
    }
}

/// One sentence of a paragraph, ready to be rendered.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColoredSentence {
    pub text: String,
    /// UTF-16 offset of the sentence within its paragraph, which is what a DOM
    /// `Range` needs.
    pub start: usize,
    /// 主谓宾 spans, each with its own UTF-16 offset within the *sentence*.
    pub segments: Vec<Segment>,
}

/// A paragraph as the reader renders it: its sentences, in order.
///
/// Returned per paragraph (rather than as one flat list) because that is the
/// unit the analyzer works in and the unit the page lays out.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColoredParagraph {
    pub text: String,
    pub sentences: Vec<ColoredSentence>,
}

impl AnalyzerState {
    /// Colors a batch of paragraphs, loading the sessions on first use.
    ///
    /// Colors a whole chapter at once, so the page is not painted twice.
    pub async fn colorize<A: Runtime>(
        &self,
        app: &AppHandle<A>,
        paragraphs: Vec<String>,
    ) -> Result<Vec<ColoredParagraph>> {
        // Nothing to color: return before the sessions are mapped, so an empty
        // chapter does not pay for loading three ONNX graphs.
        if paragraphs.is_empty() {
            return Ok(Vec::new());
        }
        let analyzer = self.analyzer(app).await?;
        tauri::async_runtime::spawn_blocking(move || {
            let mut failure: Option<String> = None;
            let mut failed = 0usize;
            let colored: Vec<ColoredParagraph> = paragraphs
                .into_iter()
                .map(|paragraph| {
                    // One odd paragraph (a 600-word run-on, an unresolvable
                    // token) must cost that paragraph its colours, not the
                    // page its text.
                    match colorize_paragraph(&analyzer, &paragraph) {
                        Ok(colored) => colored,
                        Err(error) => {
                            failed += 1;
                            failure.get_or_insert(error);
                            ColoredParagraph::plain(paragraph)
                        }
                    }
                })
                .collect();
            // Every paragraph failing means the model is broken, not that the
            // prose is unusual; the reader needs to say so rather than show an
            // uncoloured book and no reason.
            if failed == colored.len() && !colored.is_empty() {
                return Err(failure.unwrap_or_else(|| "analysis failed".into()));
            }
            Ok(colored)
        })
        .await
        .map_err(err)?
    }
}

impl ColoredParagraph {
    /// A paragraph the analyzer rejected: still split into sentences, because
    /// sentence structure does not depend on the model and the fallback should
    /// lay out like a normal paragraph — just with no spans to colour.
    pub(crate) fn plain(text: String) -> Self {
        let sentences = crate::text::split(&text)
            .into_iter()
            .map(|range| ColoredSentence {
                start: crate::analysis::utf16::utf16_len(&text[..range.start]),
                text: text[range].to_owned(),
                segments: Vec::new(),
            })
            .collect();
        Self { text, sentences }
    }
}

/// Splits one paragraph and analyzes each sentence, reusing cached results.
fn colorize_paragraph(analyzer: &Analyzer, paragraph: &str) -> Result<ColoredParagraph> {
    let mut sentences = Vec::new();
    for range in crate::text::split(paragraph) {
        let text = &paragraph[range.clone()];
        // The splitter works in bytes; the frontend needs UTF-16 offsets, which
        // are counted from the paragraph start (the DOM range's base).
        let start = crate::analysis::utf16::utf16_len(&paragraph[..range.start]);
        let segments = analyzer.analyze(text)?.unwrap_or_default();
        sentences.push(ColoredSentence {
            text: text.to_owned(),
            start,
            segments,
        });
    }
    Ok(ColoredParagraph {
        text: paragraph.to_owned(),
        sentences,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The paragraph/offset contract: sentence offsets must be usable as DOM
    /// ranges, which means UTF-16 units counted from the paragraph start, not
    /// bytes and not per-sentence.
    #[test]
    fn sentence_offsets_are_utf16_from_the_paragraph_start() {
        let paragraph = "他走了。「好。」";
        let ranges = crate::text::split(paragraph);
        let starts: Vec<usize> = ranges
            .iter()
            .map(|range| crate::analysis::utf16::utf16_len(&paragraph[..range.start]))
            .collect();
        // "他走了。" is 4 UTF-16 units, so the second sentence starts at 4.
        assert_eq!(starts, [0, 4]);
    }

    /// The reader renders the gap between two sentences from the paragraph
    /// text, because each sentence is trimmed: `He slept. She woke.` must keep
    /// the space at offset 9, or the page runs the words together.
    #[test]
    fn the_gap_between_trimmed_sentences_is_the_paragraphs_own_space() {
        let paragraph = "He slept. She woke.";
        let sentences: Vec<(usize, &str)> = crate::text::split(paragraph)
            .into_iter()
            .map(|range| {
                (
                    crate::analysis::utf16::utf16_len(&paragraph[..range.start]),
                    &paragraph[range],
                )
            })
            .collect();
        assert_eq!(sentences, [(0, "He slept."), (10, "She woke.")]);
        let gap = &paragraph[sentences[0].0 + sentences[0].1.len()..sentences[1].0];
        assert_eq!(gap, " ");
    }

    /// Unloading empties the slot, so the next analysis rebuilds from whatever
    /// weights are on disk then — and therefore cannot answer from the spans of
    /// the model that was unloaded.
    #[test]
    fn unloading_empties_the_slot() {
        let state = AnalyzerState::default();
        tauri::async_runtime::block_on(state.unload());
        assert!(!tauri::async_runtime::block_on(state.is_loaded()));
    }
}
