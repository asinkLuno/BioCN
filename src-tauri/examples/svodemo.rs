//! One-off demo generator: color a plain text file with the real 主谓宾
//! pipeline and print each sentence as SVO-wrapped HTML.
//!
//! ```sh
//! cargo run --release --example svodemo -- <in.txt>
//! ```
use std::path::PathBuf;

use biocn_lib::analysis::engine::Sessions;
use biocn_lib::analysis::{BioCNResources, analyze_sentence};
use biocn_lib::text::sentences;

fn models_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("BIOCN_MODELS") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".cache/ink.syncmoon.biocn-reader/biocn-models")
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let text = std::fs::read_to_string(
        std::env::args()
            .nth(1)
            .ok_or("usage: svodemo <in.txt>")?,
    )?;

    let dir = models_dir();
    let resources = BioCNResources::load_dir(&dir)?;
    let sessions = Sessions::load(&dir)?;

    for paragraph in text.lines() {
        let paragraph = paragraph.trim();
        if paragraph.is_empty() {
            println!();
            continue;
        }
        for sentence in sentences(paragraph) {
            let Some(segments) = analyze_sentence(&resources, &sessions, &sentence)? else {
                print!("{sentence}");
                continue;
            };
            for segment in &segments {
                let class = match segment.role {
                    biocn_lib::analysis::roles::Role::Subject => "svo-subject",
                    biocn_lib::analysis::roles::Role::Predicate => "svo-predicate",
                    biocn_lib::analysis::roles::Role::Object => "svo-object",
                    biocn_lib::analysis::roles::Role::Normal => "",
                };
                let piece = segment.text.as_str();
                if class.is_empty() {
                    print!("{piece}");
                } else {
                    print!("<span class=\"{class} font-medium\">{piece}</span>");
                }
            }
        }
        println!();
    }
    Ok(())
}
