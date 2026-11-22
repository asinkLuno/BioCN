//! The 主谓宾 analyses, on disk in SQLite.
//!
//! Coloring is what this app is *for* — the shelf is a preview of an export —
//! so an analysis is not a throwaway memo that dies with the process. Reading a
//! chapter writes it here; reading it again, tomorrow or in another book, is a
//! query instead of three ONNX sessions per sentence.
//!
//! Two tables, both keyed by a weights fingerprint:
//!
//! * `sentences` — one row per (weights, trimmed sentence text). `spans` is the
//!   folded 主谓宾 JSON, or NULL for "the analyzer rejected this sentence",
//!   which is a result worth keeping: those are exactly the run-ons that cost
//!   the most to re-analyze.
//! * `chapters` — one row per colored chapter. Existence is the whole value:
//!   it is what makes whole-book coloring resumable and what tells the progress
//!   bar how much is left.
//!
//! Nothing is ever pruned. A row here is work the user paid for (and may be
//! about to export), and a book's content hash is its id, so re-importing a
//! removed book finds its coloring intact. Deleting `analysis.db` only costs a
//! recompute — which is also why a file this build cannot read is discarded
//! instead of refusing to start the app.
//!
//! Sentences are global rather than per book: two novels sharing a line share
//! the analysis, and a sentence means the same thing wherever it appears.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, params};
use tauri::{AppHandle, Runtime};

use crate::analysis::Segment;

type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// SQLite's `user_version`. Bumped only when the tables change; a cache at any
/// other version is dropped and rebuilt.
const SCHEMA: i64 = 1;

/// Bumped when the same sentence would produce different spans than the last
/// build did (role mapping, decoding, tokenizer). Splitting is *not* part of it:
/// the sentence text is the key, so a better splitter just asks for different
/// sentences.
const PIPELINE: u32 = 1;

/// Sentences per `IN (...)` list. Well under SQLite's 32766-variable default,
/// and a chapter's worth usually fits in one query.
const CHUNK: usize = 400;

const CREATE: &str = "
    CREATE TABLE IF NOT EXISTS sentences (
        weights  TEXT NOT NULL,
        sentence TEXT NOT NULL,
        spans    TEXT,
        PRIMARY KEY (weights, sentence)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_sentences_sentence ON sentences(sentence);

    CREATE TABLE IF NOT EXISTS chapters (
        weights TEXT    NOT NULL,
        book    TEXT    NOT NULL,
        chapter INTEGER NOT NULL,
        PRIMARY KEY (weights, book, chapter)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book);
";

#[derive(Clone)]
pub struct AnalysisCache {
    inner: Arc<Inner>,
}

struct Inner {
    /// Separate read-only and write connections so WAL mode actually lets
    /// `book://` chapter reads run concurrently with whole-book writes.
    reader: Mutex<Connection>,
    writer: Mutex<Connection>,
}

/// The key the current weights' rows live under.
///
/// The stamp (variant plus one `name size` line per file) hashed, rather than
/// the weights themselves: rehashing ~70 MB on every chapter load is not worth
/// it, and the manifest's sha256 is only around at install time. What that
/// leaves is narrow — two builds with byte-identical file sizes share a cache —
/// and [`PIPELINE`] is the deliberate escape hatch for it.
pub fn weights_of_dir(dir: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};

    let stamp = std::fs::read(dir.join("stamp")).map_err(err)?;
    let mut hasher = Sha256::new();
    hasher.update(&stamp);
    let digest = format!("{:x}", hasher.finalize());
    Ok(format!("v{PIPELINE}:{}", &digest[..16]))
}

pub fn weights<R: Runtime>(app: &AppHandle<R>) -> Result<String> {
    let dir = crate::models::installed_dir(app)?;
    weights_of_dir(&dir)
}

impl AnalysisCache {
    /// Opens (or creates) `<dir>/analysis.db`.
    pub fn open(dir: &Path) -> Result<Self> {
        Self::open_with_timeout(dir, std::time::Duration::from_secs(5))
    }

    fn open_with_timeout(dir: &Path, busy_timeout: std::time::Duration) -> Result<Self> {
        std::fs::create_dir_all(dir).map_err(err)?;
        let file = dir.join("analysis.db");
        match Self::connect(&file, busy_timeout) {
            Ok(cache) => Ok(cache),
            Err(first) if is_corruption_error(&first) => {
                // Corrupt or not a SQLite file: throw it away and start over.
                // Transient lock/IO errors are NOT deleted so hours of analysis
                // cache survive contention from another process.
                for suffix in ["", "-wal", "-shm"] {
                    let _ = std::fs::remove_file(sibling(&file, suffix));
                }
                Self::connect(&file, busy_timeout)
                    .map_err(|second| format!("{first}; {second}"))
            }
            Err(first) => Err(err(first)),
        }
    }

    fn connect(
        file: &Path,
        busy_timeout: std::time::Duration,
    ) -> std::result::Result<Self, rusqlite::Error> {
        let mut conn = Connection::open(file)?;
        // Set busy_timeout first so WAL pragma and schema checks wait politely
        // if another process briefly holds a lock.
        conn.busy_timeout(busy_timeout)?;
        // WAL: a reader asking for a chapter must not wait behind the whole-book
        // job writing one. `NORMAL` because a write lost to a crash costs a
        // recompute, not correctness.
        conn.query_row("PRAGMA journal_mode = WAL", [], |row| {
            row.get::<_, String>(0)
        })?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;

        let tx = conn.transaction()?;
        let version: i64 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version != SCHEMA {
            tx.execute_batch("DROP TABLE IF EXISTS sentences; DROP TABLE IF EXISTS chapters;")?;
        }
        // `IF NOT EXISTS` so the fresh-file case and a schema bump share a path.
        tx.execute_batch(CREATE)?;
        tx.pragma_update(None, "user_version", SCHEMA)?;
        tx.commit()?;

        let reader = Connection::open_with_flags(
            file,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        reader.busy_timeout(busy_timeout)?;

        Ok(Self {
            inner: Arc::new(Inner {
                reader: Mutex::new(reader),
                writer: Mutex::new(conn),
            }),
        })
    }

    /// The analyses already known for `sentences`.
    ///
    /// A missing key means "not cached"; a present key holding `None` means the
    /// analyzer rejected that sentence. A row this build cannot parse is
    /// treated as missing, so it is recomputed and overwritten.
    pub fn get(
        &self,
        weights: &str,
        sentences: &[String],
    ) -> Result<HashMap<String, Option<Vec<Segment>>>> {
        if sentences.is_empty() {
            return Ok(HashMap::new());
        }
        let conn = self.read_lock()?;
        let mut found = HashMap::with_capacity(sentences.len());
        for chunk in sentences.chunks(CHUNK) {
            let placeholders = vec!["?"; chunk.len()].join(", ");
            let sql = format!(
                "SELECT sentence, spans FROM sentences WHERE weights = ?1 AND sentence IN ({placeholders})"
            );
            let mut statement = conn.prepare(&sql).map_err(err)?;
            let mut args: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() + 1);
            args.push(&weights);
            args.extend(
                chunk
                    .iter()
                    .map(|sentence| sentence as &dyn rusqlite::ToSql),
            );
            let mut rows = statement.query(args.as_slice()).map_err(err)?;
            while let Some(row) = rows.next().map_err(err)? {
                let sentence: String = row.get(0).map_err(err)?;
                let spans: Option<String> = row.get(1).map_err(err)?;
                let segments = match spans {
                    None => None,
                    Some(json) => match serde_json::from_str(&json) {
                        Ok(segments) => Some(segments),
                        Err(_) => continue,
                    },
                };
                found.insert(sentence, segments);
            }
        }
        Ok(found)
    }

    /// Writes `rows` and, when `complete`, marks the chapter as colored.
    ///
    /// One transaction: a chapter interrupted half-way is not marked done, so
    /// the whole-book job picks it up again instead of skipping it forever.
    pub fn save_chapter(
        &self,
        weights: &str,
        book: &str,
        chapter: usize,
        complete: bool,
        rows: &[(String, Option<Vec<Segment>>)],
    ) -> Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(err)?;
        {
            // Only sentences this run computed get here, so replacing an
            // existing row is the analyzer answering again — the newer answer
            // wins.
            let mut insert = tx
                .prepare_cached(
                    "INSERT OR REPLACE INTO sentences (weights, sentence, spans) VALUES (?1, ?2, ?3)",
                )
                .map_err(err)?;
            for (sentence, segments) in rows {
                let spans = match segments {
                    Some(segments) => Some(serde_json::to_string(segments).map_err(err)?),
                    None => None,
                };
                insert
                    .execute(params![weights, sentence, spans])
                    .map_err(err)?;
            }
            if complete {
                // `IGNORE`, not `REPLACE`: reading the same chapter again would
                // otherwise rewrite this row (and grow the WAL) every time, for
                // a marker that is already true.
                tx.execute(
                    "INSERT OR IGNORE INTO chapters (weights, book, chapter) VALUES (?1, ?2, ?3)",
                    params![weights, book, chapter as i64],
                )
                .map_err(err)?;
            }
        }
        tx.commit().map_err(err)
    }

    /// Marks a chapter colored without writing any sentences.
    ///
    /// Used when every sentence was already cached: the chapter is colored, but
    /// there is nothing to insert. Asks before writing so re-reading a colored
    /// chapter costs a read and no write transaction at all — this is the path
    /// every page turn of an already-colored book takes.
    pub fn mark_chapter(&self, weights: &str, book: &str, chapter: usize) -> Result<()> {
        {
            let conn = self.read_lock()?;
            let known: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM chapters WHERE weights = ?1 AND book = ?2 AND chapter = ?3)",
                    params![weights, book, chapter as i64],
                    |row| row.get(0),
                )
                .map_err(err)?;
            if known {
                return Ok(());
            }
        }
        // `IGNORE` for the same reason: another window may have written it
        // between the check and this line.
        let conn = self.lock()?;
        conn.execute(
            "INSERT OR IGNORE INTO chapters (weights, book, chapter) VALUES (?1, ?2, ?3)",
            params![weights, book, chapter as i64],
        )
        .map_err(err)?;
        Ok(())
    }

    /// Chapters of `book` already colored by these weights.
    pub fn colored_chapters(&self, weights: &str, book: &str) -> Result<HashSet<usize>> {
        let conn = self.read_lock()?;
        let mut statement = conn
            .prepare("SELECT chapter FROM chapters WHERE weights = ?1 AND book = ?2")
            .map_err(err)?;
        let mut rows = statement.query(params![weights, book]).map_err(err)?;
        let mut found = HashSet::new();
        while let Some(row) = rows.next().map_err(err)? {
            found.insert(row.get::<_, i64>(0).map_err(err)? as usize);
        }
        Ok(found)
    }

    /// Whether `book` has any coloring at all: a chapter marker under *any*
    /// weights — the same scope [`Self::clear_book`] works on, which is the
    /// menu the answer feeds. The sentence table is global and cannot name its
    /// book without parsing it, so the markers are the whole truth here.
    pub fn has_coloring(&self, book: &str) -> Result<bool> {
        let conn = self.read_lock()?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM chapters WHERE book = ?1)",
            params![book],
            |row| row.get(0),
        )
        .map_err(err)
    }

    /// Whether `book` has chapter markers under exactly `weights` — the slice
    /// the exporter reads, and the only one that makes an export worth asking
    /// for.
    pub fn has_coloring_under(&self, weights: &str, book: &str) -> Result<bool> {
        let conn = self.read_lock()?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM chapters WHERE weights = ?1 AND book = ?2)",
            params![weights, book],
            |row| row.get(0),
        )
        .map_err(err)
    }

    /// Forgets a book's coloring: its chapter markers and the rows its
    /// sentences keyed, under *every* weights — the user clears "this book's
    /// cache", not one fingerprint's slice of it.
    ///
    /// The sentence table is global (see the module docs), so `sentences` —
    /// the book's texts, collected by the caller, which is the one that knows
    /// how to parse — may include lines another book shares. Those rows go
    /// too: a sentence means the same thing wherever it appears, so a lost
    /// row costs the other book a recompute, never a wrong color.
    ///
    /// One transaction, so a clear that trips halfway leaves the book either
    /// cached or cleared, not half of each. The file itself does not shrink
    /// (that would take a `VACUUM`, which would hold the write lock for the
    /// length of a coloring job); the freed pages are reused by later writes.
    pub fn clear_book(&self, book: &str, sentences: &[String]) -> Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(err)?;
        tx.execute("DELETE FROM chapters WHERE book = ?1", params![book])
            .map_err(err)?;
        for chunk in sentences.chunks(CHUNK) {
            let placeholders = vec!["?"; chunk.len()].join(", ");
            let sql = format!("DELETE FROM sentences WHERE sentence IN ({placeholders})");
            let args: Vec<&dyn rusqlite::ToSql> =
                chunk.iter().map(|sentence| sentence as &dyn rusqlite::ToSql).collect();
            tx.execute(&sql, args.as_slice()).map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    fn read_lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        Ok(self
            .inner
            .reader
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        // A panic while holding the connection must not make the cache
        // permanently unusable: the data is either committed or not.
        Ok(self
            .inner
            .writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()))
    }
}

/// `analysis.db` + `-wal` / `-shm`, which SQLite names by appending.
fn sibling(file: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", file.display()))
}

fn is_corruption_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(err, _)
            if matches!(
                err.code,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
            )
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::Role;

    fn segment(text: &str, start: usize, role: Role) -> Segment {
        Segment {
            text: text.into(),
            start,
            role,
        }
    }

    fn cache() -> (tempfile::TempDir, AnalysisCache) {
        let dir = tempfile::tempdir().unwrap();
        let cache = AnalysisCache::open(dir.path()).unwrap();
        (dir, cache)
    }

    #[test]
    fn a_saved_sentence_comes_back_verbatim() {
        let (_dir, cache) = cache();
        let spans = vec![
            segment("他", 0, Role::Subject),
            segment("走", 1, Role::Predicate),
        ];
        cache
            .save_chapter(
                "w1",
                "dune",
                1,
                true,
                &[("他走。".into(), Some(spans.clone()))],
            )
            .unwrap();

        let found = cache
            .get("w1", &["他走。".into(), "没算过。".into()])
            .unwrap();
        assert_eq!(found.get("他走。"), Some(&Some(spans)));
        assert_eq!(found.get("没算过。"), None, "an unknown sentence is a miss");
    }

    /// A rejection is a result: the run-on that took three chunks of model
    /// input must not be re-analyzed on every scroll.
    #[test]
    fn a_rejected_sentence_is_cached_as_a_hit_with_no_spans() {
        let (_dir, cache) = cache();
        cache
            .save_chapter("w1", "dune", 1, true, &[("超长难句。".into(), None)])
            .unwrap();

        let found = cache.get("w1", &["超长难句。".into()]).unwrap();
        assert_eq!(
            found.get("超长难句。"),
            Some(&None),
            "present, but with no spans — different from a miss"
        );
    }

    /// The whole reason the fingerprint exists: spans from other weights must
    /// never be served, or a variant swap would show one model's colors read
    /// off another model's rows.
    #[test]
    fn rows_do_not_leak_between_weights() {
        let (_dir, cache) = cache();
        let spans = vec![segment("他", 0, Role::Subject)];
        cache
            .save_chapter("int8", "dune", 1, true, &[("他走。".into(), Some(spans))])
            .unwrap();

        assert!(cache.get("fp16", &["他走。".into()]).unwrap().is_empty());
        assert!(cache.colored_chapters("fp16", "dune").unwrap().is_empty());
    }

    #[test]
    fn a_chapter_is_marked_only_when_it_is_complete() {
        let (_dir, cache) = cache();
        cache
            .save_chapter("w1", "dune", 3, false, &[("一。".into(), None)])
            .unwrap();
        assert!(cache.colored_chapters("w1", "dune").unwrap().is_empty());

        cache.save_chapter("w1", "dune", 3, true, &[]).unwrap();
        assert_eq!(
            cache.colored_chapters("w1", "dune").unwrap(),
            HashSet::from([3])
        );
        assert!(
            cache.colored_chapters("w1", "emma").unwrap().is_empty(),
            "another book's chapters are another set"
        );
    }

    /// Re-reading a colored chapter must cost a read, not a write: paging
    /// through a finished book is the commonest thing this app does.
    #[test]
    fn marking_a_chapter_twice_changes_nothing() {
        let (_dir, cache) = cache();
        cache.mark_chapter("w1", "dune", 2).unwrap();
        cache.mark_chapter("w1", "dune", 2).unwrap();
        assert_eq!(
            cache.colored_chapters("w1", "dune").unwrap(),
            HashSet::from([2])
        );
    }

    /// The cache outlives the process: reopening the file is the point.
    #[test]
    fn what_one_connection_wrote_the_next_one_reads() {
        let dir = tempfile::tempdir().unwrap();
        {
            let cache = AnalysisCache::open(dir.path()).unwrap();
            cache
                .save_chapter("w1", "dune", 1, true, &[("他走。".into(), None)])
                .unwrap();
        }
        let cache = AnalysisCache::open(dir.path()).unwrap();
        assert!(
            cache
                .get("w1", &["他走。".into()])
                .unwrap()
                .contains_key("他走。")
        );
        assert_eq!(
            cache.colored_chapters("w1", "dune").unwrap(),
            HashSet::from([1])
        );
    }

    /// A file that is not a database at all is rebuilt, not fatal.
    #[test]
    fn a_corrupt_file_is_discarded_and_recreated() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("analysis.db"), b"not a database").unwrap();

        let cache = AnalysisCache::open(dir.path()).unwrap();
        cache
            .save_chapter("w1", "dune", 1, true, &[("他走。".into(), None)])
            .unwrap();
        assert!(
            cache
                .get("w1", &["他走。".into()])
                .unwrap()
                .contains_key("他走。")
        );
    }

    /// A row written by a build that serialized spans differently is a miss,
    /// not an error: the sentence is recomputed and the row replaced.
    #[test]
    fn an_unparseable_row_reads_as_a_miss() {
        let (_dir, cache) = cache();
        cache
            .save_chapter("w1", "dune", 1, true, &[("他走。".into(), None)])
            .unwrap();
        {
            let conn = cache.lock().unwrap();
            conn.execute(
                "UPDATE sentences SET spans = ?1 WHERE sentence = ?2",
                params!["{\"nope\": true}", "他走。"],
            )
            .unwrap();
        }

        assert!(cache.get("w1", &["他走。".into()]).unwrap().is_empty());
    }

    /// Clearing a book removes the rows its sentences keyed and its chapter
    /// markers — across *every* weights, which is what "这本书的缓存" means
    /// to the user. Rows another book shares go with it: a sentence means the
    /// same thing wherever it appears, so losing one costs a recompute, never
    /// a wrong color.
    #[test]
    fn clearing_a_book_removes_its_rows_and_leaves_the_others() {
        let (_dir, cache) = cache();
        let shared = "两个故事都有的一句。";
        cache
            .save_chapter("w1", "dune", 1, true, &[("沙丘的话。".into(), None)])
            .unwrap();
        cache
            .save_chapter("w1", "emma", 1, true, &[("艾玛的话。".into(), None)])
            .unwrap();
        cache
            .save_chapter("w1", "dune", 2, true, &[(shared.to_owned(), None)])
            .unwrap();
        cache
            .save_chapter("w1", "emma", 3, true, &[(shared.to_owned(), None)])
            .unwrap();
        // The same sentence under another fingerprint: a variant the user
        // activated once and left.
        cache
            .save_chapter("w2", "dune", 1, true, &[("沙丘的话。".into(), None)])
            .unwrap();

        cache
            .clear_book("dune", &[shared.to_owned(), "沙丘的话。".to_owned()])
            .unwrap();

        assert!(
            cache.colored_chapters("w1", "dune").unwrap().is_empty(),
            "the cleared book's markers are gone"
        );
        assert!(
            cache.colored_chapters("w2", "dune").unwrap().is_empty(),
            "so are its markers under other weights"
        );
        assert_eq!(
            cache.colored_chapters("w1", "emma").unwrap(),
            HashSet::from([1, 3]),
            "another book's markers are another book's"
        );
        let found = cache
            .get(
                "w1",
                &["沙丘的话。".into(), "艾玛的话。".into()],
            )
            .unwrap();
        assert_eq!(found.get("沙丘的话。"), None, "the book's own row is gone");
        assert!(
            found.contains_key("艾玛的话。"),
            "a sentence only emma has stays"
        );
        // The shared row went too: the cleared book held it, and re-analysis
        // of one sentence is the price of an honest clear.
        assert_eq!(cache.get("w1", &[shared.to_owned()]).unwrap().get(shared), None);
    }

    /// The book menu greys its clear item off unless the book holds coloring,
    /// under *any* weights — the same scope the clear itself works on.
    #[test]
    fn a_book_has_coloring_only_while_it_has_markers() {
        let (_dir, cache) = cache();
        assert!(!cache.has_coloring("dune").unwrap(), "a fresh book has none");

        cache
            .save_chapter("w1", "dune", 1, true, &[("沙丘的话。".into(), None)])
            .unwrap();
        assert!(cache.has_coloring("dune").unwrap());
        assert!(
            !cache.has_coloring("emma").unwrap(),
            "another book's markers are not this book's"
        );

        // A variant the user activated once and left still counts: the clear
        // would remove it, so the menu must offer it.
        cache
            .save_chapter("w2", "dune", 2, true, &[("别的变体。".into(), None)])
            .unwrap();
        assert!(cache.has_coloring("dune").unwrap());

        cache.clear_book("dune", &["沙丘的话。".to_owned(), "别的变体。".to_owned()]).unwrap();
        assert!(!cache.has_coloring("dune").unwrap(), "a cleared book has none");
    }

    /// The exporter reads only the active weights' slice: a book colored under
    /// a variant the user left must not offer an export that would write a
    /// plain book.
    #[test]
    fn coloring_under_the_active_weights_is_what_export_asks_about() {
        let (_dir, cache) = cache();
        cache
            .save_chapter("w1", "dune", 1, true, &[("沙丘的话。".into(), None)])
            .unwrap();

        assert!(cache.has_coloring_under("w1", "dune").unwrap());
        assert!(
            !cache.has_coloring_under("w2", "dune").unwrap(),
            "another weights' slice is not this one"
        );
        assert!(
            !cache.has_coloring_under("w1", "emma").unwrap(),
            "another book's slice is not this one"
        );
        assert!(
            cache.has_coloring("dune").unwrap(),
            "the any-weights check (the clear's scope) still sees it"
        );
    }

    /// A novel's worth of sentences exceeds one `IN (...)` list, and a delete
    /// that silently stopped at the first chunk would leave most rows behind.
    #[test]
    fn clearing_a_book_deletes_past_one_chunk() {
        let (_dir, cache) = cache();
        let sentences: Vec<String> = (0..900).map(|index| format!("第{index}句。")).collect();
        let keys: Vec<String> = sentences.clone();
        cache
            .save_chapter("w1", "dune", 1, true, &keys.iter().map(|s| (s.clone(), None)).collect::<Vec<_>>())
            .unwrap();
        cache
            .save_chapter("w1", "emma", 1, true, &[("艾玛的话。".into(), None)])
            .unwrap();

        cache.clear_book("dune", &sentences).unwrap();

        let left = cache.get("w1", &keys).unwrap();
        assert!(left.is_empty(), "{}/{} rows survived the clear", left.len(), keys.len());
        assert!(cache.get("w1", &["艾玛的话。".into()]).unwrap().contains_key("艾玛的话。"));
    }

    #[test]
    fn open_does_not_delete_database_on_non_corruption_error() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AnalysisCache::open(dir.path()).unwrap();
        cache
            .save_chapter("w1", "dune", 0, true, &[("保住缓存。".into(), None)])
            .unwrap();
        drop(cache);

        // Hold an exclusive lock on analysis.db from another connection while
        // trying to open with a 1ms busy timeout (simulated via helper).
        let file = dir.path().join("analysis.db");
        let blocker = Connection::open(&file).unwrap();
        blocker.execute_batch("BEGIN EXCLUSIVE;").unwrap();

        let result = AnalysisCache::open_with_timeout(dir.path(), std::time::Duration::from_millis(10));
        assert!(result.is_err(), "busy database must return error instead of recreating");

        blocker.execute_batch("ROLLBACK;").unwrap();
        drop(blocker);

        // Data must still be intact after the transient lock clears.
        let reopened = AnalysisCache::open(dir.path()).unwrap();
        assert!(
            reopened.has_coloring("dune").unwrap(),
            "transient lock error must not wipe existing analysis cache"
        );
    }
}
