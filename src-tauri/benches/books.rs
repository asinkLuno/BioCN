//! Whole-book coloring speed, measured the way a whole-book coloring job
//! measures a book: EPUB -> chapters -> paragraphs -> `text::split`, then
//! every unique sentence through the app's pipeline — duplicate sentences
//! answered once, which is what the SQLite cache does for a real job. No UI,
//! no cache, no export: parse, split and model time only.
//!
//! Run modes, all over the same unique sentences:
//!
//! * default mode  — the app's own shape: one `analyze_all` batch per
//!   chapter, with sentences answered earlier in the book skipped (the
//!   cross-chapter effect of the SQLite cache);
//! * `--stages`    — a timed stage-by-stage mirror, one Instant per stage,
//!   spot-checked against the pipeline's answers; a mismatch fails.
//! ```sh
//! cargo bench -p biocn --bench books -- [flags] <models-root> <book.epub>...
//! ```
//!
//! `<models-root>` is the app's models dir (…/models): one subdir per variant
//! (`int8/`, `fp16/`), each carrying the `.ort` weights *and* the vocab/label
//! tables, exactly as `models.rs` installs them. Sessions load once per
//! (variant, threads) config, like the app's lazily-created analyzer — the
//! load cost is reported separately, not in the per-book times.
//!
//! Flags, to simulate configurations the app could ship:
//!
//! * `--variant=int8[,fp16]`  weight sets (default: both)
//! * `--threads=auto,1,2,4,…` ORT intra threads; sessions reload per value
//!   (`auto` = the app's default formula). Crossed with variants.
//! * `--stages`               per-stage wall-time split instead of the run.
//! * `--limit=N`              analyze only the first N unique sentences per
//!   chapter (book-wide for `--pipeline`) — quick matrices on
//!   a big book stay honest *relatively* (every config sees the same
//!   subset), less so absolutely.
//!
//! The runtime library comes from `ORT_DYLIB_PATH` if set, else the repo
//! build at `src-tauri/ort/<platform>/libonnxruntime.so` — the bench binary
//! lives in target/{release,bench}/deps, so neither of the engine's other
//! two lookup paths would find it.
//!
//! Numbers are wall time via `Instant`; the loops do nothing but analysis.
//! ORT keeps its own intra threads (`engine::threads`).
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use biocn_lib::analysis::decode::{Word, decode_dep, decode_pos, decode_words};
use biocn_lib::analysis::engine::Sessions;
use biocn_lib::analysis::resources::{pack_word_rows, tok_prep, words_prep};
use biocn_lib::analysis::roles::{char_roles, to_segments};
use biocn_lib::analysis::utf16::to_utf16;
use biocn_lib::analysis::{BioCNResources, MAX_SUBS, MAX_WORDS, analyze_all};
use biocn_lib::reader;

/// Same order as `models.rs` publishes them.
const VARIANTS: [&str; 2] = ["int8", "fp16"];

struct Book {
    title: String,
    chapters: usize,
    /// Non-whitespace characters across all paragraphs — what 字数 means here.
    chars: usize,
    sentences: Vec<String>,
    /// Indices of first occurrences: the sentences a fresh coloring job
    /// actually analyzes. Truncatable for `--limit`.
    unique: Vec<usize>,
    /// The same per chapter — the batch shape the app actually runs
    /// (`run_chapters`); `unique` stays book-wide for the other modes.
    chapter_uniques: Vec<Vec<usize>>,
    parse: Duration,
    split: Duration,
}

/// One config over one book.
struct Record {
    book: String,
    variant: &'static str,
    threads: String,
    model: Duration,
    analyzed: usize,
    failed: usize,
    /// Set when sessions would not load, or every sentence failed — the two
    /// cases the app treats as a broken model rather than odd prose.
    error: Option<String>,
}

/// Sessions + tables for one (variant, threads) config.
struct Loaded {
    resources: BioCNResources,
    sessions: Sessions,
    load: Duration,
}

fn main() {
    // `cargo bench` appends its own `--bench` mode flag to argv even for a
    // `harness = false` binary; flags we do not know are an error, bare
    // positionals are the models dir and the books.
    let mut variants: Vec<String> = VARIANTS.iter().map(|v| v.to_string()).collect();
    let mut threads: Vec<String> = vec!["auto".to_owned()];
    let mut limit: Option<usize> = None;
    let mut stages = false;
    let mut pipeline = false;
    let mut positional: Vec<String> = Vec::new();
    for arg in std::env::args().skip(1) {
        if let Some(value) = arg.strip_prefix("--variant=") {
            variants = value.split(',').map(|v| v.to_owned()).collect();
            if variants.iter().any(|v| !VARIANTS.contains(&v.as_str())) {
                usage(&format!("unknown variant in {value}"));
            }
        } else if let Some(value) = arg.strip_prefix("--threads=") {
            threads = value.split(',').map(|v| v.to_owned()).collect();
            if threads.iter().any(|v| v != "auto" && v.parse::<usize>().is_err()) {
                usage(&format!("bad --threads={value}"));
            }
        } else if let Some(value) = arg.strip_prefix("--limit=") {
            limit = value.parse().ok();
        } else if arg == "--stages" {
            stages = true;
        } else if arg == "--pipeline" {
            pipeline = true;
        } else if arg == "--bench" {
            // `cargo bench` appends its own mode flag to the argv of a
            // `harness = false` binary; not one of ours, just drop it.
        } else if arg.starts_with('-') {
            usage(&format!("unknown flag {arg}"));
        } else {
            positional.push(arg);
        }
    }
    let [models, books @ ..] = positional.as_slice() else {
        usage("need <models-root> and at least one book");
    };
    let models = PathBuf::from(models);

    point_at_runtime();
    println!(
        "onnxruntime: {}",
        std::env::var("ORT_DYLIB_PATH").as_deref().unwrap_or("(system SONAME)")
    );

    let mut parsed = Vec::new();
    for path in books {
        match load_book(Path::new(path)) {
            Ok(book) => {
                println!(
                    "《{}》 chapters={} chars={} sentences={} unique={} parse={:.2}s split={:.2}s",
                    book.title,
                    book.chapters,
                    book.chars,
                    book.sentences.len(),
                    book.unique.len(),
                    book.parse.as_secs_f64(),
                    book.split.as_secs_f64(),
                );
                parsed.push(book);
            }
            Err(error) => eprintln!("  SKIP {path}: {error}"),
        }
    }
    if parsed.is_empty() {
        eprintln!("no book parsed");
        std::process::exit(1);
    }
    if let Some(limit) = limit {
        for book in &mut parsed {
            book.unique.truncate(limit);
            for chapter in &mut book.chapter_uniques {
                chapter.truncate(limit);
            }
        }
        println!("limit: first {limit} unique sentences per chapter/book");
    }

    // Standalone modes use the first variant/threads flag and skip the matrix.
    let variant = as_variant(&variants[0]);
    let threads_first = threads[0].as_str();
    if stages {
        mode_stages(&models, variant, threads_first, &parsed);
        return;
    }
    if pipeline {
        mode_pipeline(&models, variant, threads_first, &parsed);
        return;
    }

    // One environment per process; per-config session reloads re-read the
    // threads knob at commit time.
    let mut records: Vec<Record> = Vec::new();
    for variant in &variants {
        for thread_config in &threads {
            let loaded = match load_variant(&models, variant, thread_config) {
                Ok(loaded) => loaded,
                Err(error) => {
                    println!("  {variant} t={thread_config}: FAILED — {error}");
                    for book in &parsed {
                        records.push(Record {
                            book: book.title.clone(),
                            variant: as_variant(variant),
                            threads: thread_config.clone(),
                            model: Duration::ZERO,
                            analyzed: 0,
                            failed: 0,
                            error: Some(error.clone()),
                        });
                    }
                    continue;
                }
            };
            println!(
                "{variant} t={thread_config}: load={:.2}s",
                loaded.load.as_secs_f64()
            );
            // What the app actually runs — per-chapter batches.
            for book in &parsed {
                let run =
                    run_chapters(book, &loaded, as_variant(variant), thread_config);
                report(
                    &format!("{variant} t={thread_config} chapters"),
                    &book.title,
                    &run,
                );
                records.push(run);
            }
        }
    }

    println!("\n== 模型耗时 秒 | 唯一句/秒（不含解析/分句/载入） ==");
    for book in &parsed {
        println!("《{}》", truncate(&book.title));
        for record in records.iter().filter(|r| r.book == book.title) {
            if record.error.is_some() {
                println!("  {} t={}: 失败", record.variant, record.threads);
            } else {
                println!(
                    "  {} t={}: {:.1}s  {:.1}/s",
                    record.variant,
                    record.threads,
                    record.model.as_secs_f64(),
                    record.analyzed as f64 / record.model.as_secs_f64().max(f64::EPSILON),
                );
            }
        }
    }
}

fn as_variant(name: &str) -> &'static str {
    VARIANTS.iter().find(|v| **v == name).copied().unwrap_or("int8")
}

fn load_variant(models: &Path, variant: &str, threads: &str) -> Result<Loaded, String> {
    set_intra_threads(threads);
    let dir = models.join(variant);
    let started = Instant::now();
    let resources = BioCNResources::load_dir(&dir).map_err(|e| e.to_string())?;
    let sessions = Sessions::load(&dir).map_err(|e| e.to_string())?;
    Ok(Loaded {
        resources,
        sessions,
        load: started.elapsed(),
    })
}

/// The knob `engine::threads` reads; `auto` clears it. Single-threaded here
/// and no session exists yet in this round, so nothing races the read.
fn set_intra_threads(threads: &str) {
    unsafe {
        match threads {
            "auto" => std::env::remove_var("ORT_INTRA_THREADS"),
            n => std::env::set_var("ORT_INTRA_THREADS", n),
        }
    }
}


/// Default mode: the shape the app runs — one `analyze_all` batch per
/// chapter, over that chapter's cache misses. `seen` is the SQLite cache's
/// cross-chapter effect: answered once, never analyzed again this book.
/// shortcut: a sentence that failed is not retried in a later chapter (the
/// app retries — failures are not cached); fine while failures are rare.
fn run_chapters(book: &Book, loaded: &Loaded, variant: &'static str, threads: &str) -> Record {
    let started = Instant::now();
    let mut analyzed = 0usize;
    let mut failed = 0usize;
    let mut first_error: Option<String> = None;
    let mut seen = std::collections::HashSet::new();

    for chapter in &book.chapter_uniques {
        let misses: Vec<&str> = chapter
            .iter()
            .map(|&index| book.sentences[index].as_str())
            .filter(|sentence| seen.insert(*sentence))
            .collect();
        for (_sentence, answer) in analyze_all(&loaded.resources, &loaded.sessions, &misses) {
            analyzed += 1;
            if let Err(error) = answer {
                failed += 1;
                first_error.get_or_insert(error);
            }
        }
    }

    let model = started.elapsed();
    let error = if failed > 0 && failed == analyzed {
        Some(first_error.unwrap_or_else(|| "分析失败".into()))
    } else {
        None
    };
    Record {
        book: book.title.clone(),
        variant,
        threads: threads.to_owned(),
        model,
        analyzed,
        failed,
        error,
    }
}

/// One line per (book, config) run, so the modes stay comparable.
fn report(label: &str, title: &str, run: &Record) {
    match &run.error {
        None => println!(
            "  《{}》 {label}: model={:.2}s {:.1} unique/s failed={}",
            truncate(title),
            run.model.as_secs_f64(),
            run.analyzed as f64 / run.model.as_secs_f64().max(f64::EPSILON),
            run.failed,
        ),
        Some(error) => println!("  《{}》 {label}: FAILED — {error}", truncate(title)),
    }
}
/// Per-stage wall time inside the staged mirror. ORT stages are
/// the three model calls; everything else is the pure-Rust half of the
/// pipeline, which a pipelined layout can hand to whichever stage it fits.
#[derive(Default)]
struct StageTimes {
    utf16_tok_prep: Duration,
    run_tok: Duration,
    decode_words: Duration,
    pos_prep: Duration,
    run_pos: Duration,
    decode_pos: Duration,
    dep_prep: Duration,
    run_dep: Duration,
    decode_dep: Duration,
    roles: Duration,
}

impl StageTimes {
    fn total(&self) -> Duration {
        self.utf16_tok_prep
            + self.run_tok
            + self.decode_words
            + self.pos_prep
            + self.run_pos
            + self.decode_pos
            + self.dep_prep
            + self.run_dep
            + self.decode_dep
            + self.roles
    }

    const ROWS: [(&'static str, fn(&StageTimes) -> Duration); 10] = [
        ("utf16+tok_prep", |t| t.utf16_tok_prep),
        ("run_tok", |t| t.run_tok),
        ("decode_words", |t| t.decode_words),
        ("words_prep+pack_pos", |t| t.pos_prep),
        ("run_pos", |t| t.run_pos),
        ("decode_pos", |t| t.decode_pos),
        ("pack_dep", |t| t.dep_prep),
        ("run_dep", |t| t.run_dep),
        ("decode_dep+eisner", |t| t.decode_dep),
        ("roles+segments", |t| t.roles),
    ];
}

/// One sentence through `pipeline.rs` stage by stage — a timed mirror of
/// what the pipeline threads run, one Instant per step. The staged segments
/// are spot-checked against the real `analyze_all` so a drifting mirror
/// cannot lie in the report.
fn staged_sentence(
    res: &BioCNResources,
    sessions: &Sessions,
    sentence: &str,
    times: &mut StageTimes,
) -> Result<Option<Vec<biocn_lib::analysis::Segment>>, String> {
    let started = Instant::now();
    let text = to_utf16(sentence);
    let prep = tok_prep(&text, res);
    times.utf16_tok_prep += started.elapsed();
    let (ids, offs) = (prep.ids, prep.offs);
    if offs.is_empty() {
        return Ok(None);
    }

    let runs = offs.len().div_ceil(MAX_SUBS);
    let mut words: Vec<Word> = Vec::new();
    for r in 0..runs {
        let g0 = r * MAX_SUBS;
        let g1 = (g0 + MAX_SUBS).min(offs.len());
        let chunk_offs = &offs[g0..g1];

        let mut chunk: Vec<i64> = Vec::with_capacity(chunk_offs.len() + 2);
        chunk.push(ids[0]); // [CLS]
        chunk.extend_from_slice(&ids[1 + g0..1 + g1]);
        chunk.push(*ids.last().unwrap()); // [SEP]

        let started = Instant::now();
        let logits = sessions
            .run_tok(&chunk, (1, chunk.len() as i64))
            .map_err(|e| e.to_string())?;
        times.run_tok += started.elapsed();

        let started = Instant::now();
        words.extend(decode_words(&text, chunk_offs, res, &logits));
        times.decode_words += started.elapsed();
    }
    if words.is_empty() {
        return Ok(None);
    }

    let mut pos: Vec<String> = Vec::new();
    let mut deps: Vec<biocn_lib::analysis::Dep> = Vec::new();
    let mut w0 = 0;
    while w0 < words.len() {
        let chunk_words: Vec<String> = words[w0..(w0 + MAX_WORDS).min(words.len())]
            .iter()
            .map(|w| w.text.clone())
            .collect();
        let started = Instant::now();
        let prep2 = words_prep(&chunk_words, res);
        let packed_pos = pack_word_rows(&prep2.ids, &prep2.spans, 0);
        times.pos_prep += started.elapsed();

        let started = Instant::now();
        let pos_logits = sessions
            .run_pos(
                &packed_pos.input_ids,
                packed_pos.input_shape,
                &packed_pos.token_span,
                packed_pos.span_shape,
            )
            .map_err(|e| e.to_string())?;
        times.run_pos += started.elapsed();

        let started = Instant::now();
        pos.extend(decode_pos(res, &pos_logits, chunk_words.len()));
        times.decode_pos += started.elapsed();

        let started = Instant::now();
        let packed_dep = pack_word_rows(&prep2.ids, &prep2.spans, 1);
        times.dep_prep += started.elapsed();

        // Same mask rule as `pipeline.rs`: the MODEL gets all-True.
        let all_true = vec![1u8; packed_dep.mask.len()];
        let started = Instant::now();
        let (s_arc, s_rel) = sessions
            .run_dep(
                &packed_dep.input_ids,
                packed_dep.input_shape,
                &packed_dep.token_span,
                packed_dep.span_shape,
                &all_true,
            )
            .map_err(|e| e.to_string())?;
        times.run_dep += started.elapsed();

        let started = Instant::now();
        deps.extend(decode_dep(res, &s_arc, &s_rel, chunk_words.len()));
        times.decode_dep += started.elapsed();

        w0 += MAX_WORDS;
    }

    let started = Instant::now();
    let tokens: Vec<String> = words.iter().map(|w| w.text.clone()).collect();
    let roles = char_roles(&text, &tokens, &deps, &pos);
    let segments = to_segments(&text, &roles);
    times.roles += started.elapsed();
    Ok(Some(segments))
}

/// `--stages`: per-stage wall time over every unique sentence, plus a
/// spot-check that the timed mirror produces exactly what the app produces.
fn mode_stages(models: &Path, variant: &'static str, threads: &str, books: &[Book]) {
    let loaded = match load_variant(models, variant, threads) {
        Ok(loaded) => loaded,
        Err(error) => {
            println!("{variant} t={threads}: FAILED — {error}");
            return;
        }
    };
    println!("{variant} t={threads}: stage split (spot-check vs analyze_all)\n");
    let mut total_mismatch = 0usize;
    for book in books {
        let mut times = StageTimes::default();
        let mut none = 0usize;
        let mut failed = 0usize;
        let mut first_error: Option<String> = None;
        let mut checked = 0usize;
        let mut mismatch = 0usize;
        let started = Instant::now();
        for &index in &book.unique {
            let sentence = &book.sentences[index];
            let staged = staged_sentence(&loaded.resources, &loaded.sessions, sentence, &mut times);
            // A drifting mirror would report a stage split for a pipeline the
            // app does not run; compare outputs on a small subset. The mirror
            // runs per sentence, the reference is the pipeline in batch mode.
            if checked < 300 {
                let reference = analyze_all(
                    &loaded.resources,
                    &loaded.sessions,
                    &[sentence],
                );
                let real = reference.first().map(|(_, answer)| answer.clone());
                // Err-vs-Ok is a drift too, not just a different segment
                // list; matching errors are the same failure twice.
                let same = match (&staged, &real) {
                    (Ok(a), Some(Ok(b))) => a == b,
                    (Err(_), Some(Err(_))) => true,
                    _ => false,
                };
                mismatch += !same as usize;
                checked += 1;
            }
            match &staged {
                Ok(Some(_)) => {}
                Ok(None) => none += 1,
                Err(error) => {
                    failed += 1;
                    first_error.get_or_insert_with(|| error.clone());
                }
            }
        }
        let wall = started.elapsed();
        let total = times.total();
        println!(
            "《{}》 {}句 none={} failed={} wall={:.2}s sum={:.2}s mismatch={}/{}",
            truncate(&book.title),
            book.unique.len(),
            none,
            failed,
            wall.as_secs_f64(),
            total.as_secs_f64(),
            mismatch,
            checked,
        );
        if let Some(error) = first_error {
            println!("  first error: {error}");
        }
        for (name, pick) in StageTimes::ROWS {
            let stage = pick(&times);
            println!(
                "  {:<20} {:>8.2}s  {:>5.1}%  {:>7.1}ms/句",
                name,
                stage.as_secs_f64(),
                stage.as_secs_f64() / total.as_secs_f64().max(f64::EPSILON) * 100.0,
                stage.as_secs_f64() * 1000.0 / book.unique.len() as f64,
            );
        }
        total_mismatch += mismatch;
    }
    if total_mismatch > 0 {
        eprintln!("stage mirror drifted on {total_mismatch} sentences");
        std::process::exit(1);
    }
}

/// `--pipeline`: steady state — the whole book in ONE `analyze_all` batch.
/// No batch ever drains, so this is a throughput ceiling; the per-chapter
/// rate the default mode reports is what a real job actually sees.
fn mode_pipeline(models: &Path, variant: &'static str, threads: &str, books: &[Book]) {
    let loaded = match load_variant(models, variant, threads) {
        Ok(loaded) => loaded,
        Err(error) => {
            println!("{variant} t={threads}: FAILED — {error}");
            return;
        }
    };
    println!("{variant} t={threads}: steady state (whole book, one analyze_all batch)\n");
    for book in books {
        let misses: Vec<&str> = book
            .unique
            .iter()
            .map(|&index| book.sentences[index].as_str())
            .collect();
        let none = AtomicUsize::new(0);
        let segments = AtomicUsize::new(0);
        let failed = AtomicUsize::new(0);
        let first_error: Mutex<Option<String>> = Mutex::new(None);

        let started = Instant::now();
        for (_sentence, answer) in analyze_all(&loaded.resources, &loaded.sessions, &misses) {
            match answer {
                Ok(Some(segs)) => {
                    segments.fetch_add(segs.len(), Ordering::Relaxed);
                }
                Ok(None) => {
                    none.fetch_add(1, Ordering::Relaxed);
                }
                Err(error) => {
                    failed.fetch_add(1, Ordering::Relaxed);
                    first_error
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .get_or_insert_with(|| error);
                }
            }
        }
        let wall = started.elapsed();

        let analyzed = book.unique.len();
        println!(
            "  《{}》 pipeline: model={:.2}s {:.1} unique/s segments={} none={} failed={}",
            truncate(&book.title),
            wall.as_secs_f64(),
            analyzed as f64 / wall.as_secs_f64().max(f64::EPSILON),
            segments.load(Ordering::Relaxed),
            none.load(Ordering::Relaxed),
            failed.load(Ordering::Relaxed),
        );
        if let Some(error) = first_error.into_inner().unwrap_or_else(|p| p.into_inner()) {
            println!("    first error: {error}");
        }
    }
}

fn load_book(path: &Path) -> Result<Book, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let title = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("?")
        .to_owned();

    let started = Instant::now();
    let chapters = reader::chapters(file).map_err(|e| e.to_string())?;
    let parse = started.elapsed();

    let started = Instant::now();
    let mut chars = 0usize;
    let mut sentences = Vec::new();
    let mut chapter_uniques = Vec::new();
    for chapter in &chapters {
        let mut local = std::collections::HashSet::new();
        let mut uniques = Vec::new();
        for paragraph in &chapter.paragraphs {
            chars += paragraph.text.chars().filter(|c| !c.is_whitespace()).count();
            for range in biocn_lib::text::split(&paragraph.text) {
                let text = &paragraph.text[range];
                if local.insert(text) {
                    uniques.push(sentences.len());
                }
                sentences.push(text.to_owned());
            }
        }
        chapter_uniques.push(uniques);
    }
    let split = started.elapsed();

    let mut seen = std::collections::HashSet::new();
    let unique = sentences
        .iter()
        .enumerate()
        .filter(|(_, sentence)| seen.insert(sentence.as_str()))
        .map(|(index, _)| index)
        .collect();
    Ok(Book {
        title,
        chapters: chapters.len(),
        chars,
        sentences,
        unique,
        chapter_uniques,
        parse,
        split,
    })
}

#[cfg(target_os = "linux")]
const ORT_PLATFORM: &str = "linux";
#[cfg(target_os = "macos")]
const ORT_PLATFORM: &str = "darwin";
#[cfg(target_os = "windows")]
const ORT_PLATFORM: &str = "windows";

#[cfg(target_os = "linux")]
const RUNTIME_LIB: &str = "libonnxruntime.so";
#[cfg(target_os = "macos")]
const RUNTIME_LIB: &str = "libonnxruntime.dylib";
#[cfg(target_os = "windows")]
const RUNTIME_LIB: &str = "libonnxruntime.dll";

/// Desktop `Sessions::load` finds the runtime library via `ORT_DYLIB_PATH`,
/// next to the executable, or by bare SONAME. Default to the repo build.
fn point_at_runtime() {
    if std::env::var_os("ORT_DYLIB_PATH").is_some() {
        return;
    }
    let lib = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("ort")
        .join(ORT_PLATFORM)
        .join(RUNTIME_LIB);
    if lib.is_file() {
        // Edition 2024 makes `set_var` unsafe: sound here — single-threaded,
        // and nothing (ORT least of all) has read the var yet.
        unsafe { std::env::set_var("ORT_DYLIB_PATH", &lib) };
    }
}

/// Console columns and CJK widths disagree; keep titles short instead of
/// fighting alignment.
fn truncate(title: &str) -> String {
    let mut out: String = title.chars().take(20).collect();
    if title.chars().count() > 20 {
        out.push('…');
    }
    out
}

fn usage(reason: &str) -> ! {
    eprintln!(
        "{reason}\nusage: cargo bench -p biocn --bench books -- \
         [--variant=int8,fp16] [--threads=auto,1,2] [--limit=N] \
         <models-root> <book.epub>..."
    );
    std::process::exit(2);
}
