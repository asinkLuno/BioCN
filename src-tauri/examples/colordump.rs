//! End-to-end check: a real EPUB -> paragraphs -> sentences -> 主谓宾 spans.
//!
//! ```sh
//! cargo run --release --example colordump -- <book.epub> [chapter-index] [paragraph-count]
//! ```
//!
//! Model files are taken from the desktop app's data dir when they exist there;
//! otherwise `$BIOCN_MODELS` (a directory holding the three `.ort` files and the
//! five tables) is used, which is how this runs in development against
//! `~/.cache/ink.syncmoon.biocn-reader/biocn-models`.

use std::path::PathBuf;

use biocn_lib::analysis::engine::Sessions;
use biocn_lib::analysis::{BioCNResources, analyze_sentence};

fn models_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("BIOCN_MODELS") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".cache/ink.syncmoon.biocn-reader/biocn-models")
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut args = std::env::args().skip(1);
    let book = args
        .next()
        .ok_or("usage: colordump <book.epub> [chapter] [paragraphs]")?;
    let want_chapter: usize = args.next().map(|a| a.parse()).transpose()?.unwrap_or(1);
    let want_paragraphs: usize = args.next().map(|a| a.parse()).transpose()?.unwrap_or(3);

    let started = std::time::Instant::now();
    let chapters = biocn_lib::reader::chapters(std::fs::File::open(&book)?)?;
    println!(
        "parsed {} chapters in {:?}",
        chapters.len(),
        started.elapsed()
    );

    let chapter = chapters
        .iter()
        .find(|chapter| chapter.index == want_chapter)
        .ok_or("no such chapter")?;
    println!(
        "chapter {} {:?}: {} paragraphs",
        chapter.index,
        chapter.title.as_deref().unwrap_or("-"),
        chapter.paragraphs.len()
    );

    let dir = models_dir();
    let resources = BioCNResources::load_dir(&dir)?;
    let sessions = Sessions::load(&dir)?;
    println!("sessions loaded in {:?}", started.elapsed());

    let mut analyzed = 0usize;
    let mut sentences = 0usize;
    let mut missing = 0usize;
    let mut colored = 0usize;

    for paragraph in chapter.paragraphs.iter().take(want_paragraphs + 40) {
        if analyzed >= want_paragraphs {
            break;
        }
        let ranges = biocn_lib::text::split(&paragraph.text);
        // Long paragraphs (a 1200-character run-on) blow the model's 500-word
        // window; the reader is supposed to survive that, so skip them here and
        // let the unit tests cover the fallback.
        if ranges.is_empty() {
            continue;
        }
        analyzed += 1;
        println!("\n--- {}", paragraph.text);
        for range in ranges {
            sentences += 1;
            let sentence = &paragraph.text[range.clone()];
            let start = biocn_lib::analysis::utf16::utf16_len(&paragraph.text[..range.start]);
            match analyze_sentence(&resources, &sessions, sentence)? {
                Some(analysis) => {
                    let spans: Vec<String> = analysis
                        .segments
                        .iter()
                        .filter(|segment| segment.role != biocn_lib::analysis::Role::Normal)
                        .map(|segment| format!("{:?}({})", segment.role, segment.text))
                        .collect();
                    if spans.is_empty() {
                        missing += 1;
                        println!("  [{start}] {sentence}  (无主谓宾)");
                    } else {
                        colored += 1;
                        println!("  [{start}] {}  -> {}", sentence, spans.join(" "));
                    }
                }
                None => {
                    missing += 1;
                    println!("  [{start}] {sentence}  (模型无语)");
                }
            }
        }
    }
    println!(
        "\n{sentences} sentences, {colored} colored, {missing} without 主谓宾, {:?} total",
        started.elapsed()
    );
    Ok(())
}
