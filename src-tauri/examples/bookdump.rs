//! Temporary harness: dump chapter/paragraph counts for real EPUBs.
//!
//! `cargo run --release --example bookdump -- <book.epub>…`

fn main() {
    for path in std::env::args().skip(1) {
        let file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(error) => {
                eprintln!("{path}: {error}");
                continue;
            }
        };
        match biocn_lib::reader::chapters(file) {
            Ok(chapters) => {
                let paragraphs: usize = chapters.iter().map(|c| c.paragraphs.len()).sum();
                let chars: usize = chapters
                    .iter()
                    .flat_map(|c| c.paragraphs.iter())
                    .map(|p| p.text.chars().count())
                    .sum();
                let empty = chapters.iter().filter(|c| c.paragraphs.is_empty()).count();
                let titled = chapters.iter().filter(|c| c.title.is_some()).count();
                let longest = chapters
                    .iter()
                    .flat_map(|c| c.paragraphs.iter())
                    .map(|p| p.text.chars().count())
                    .max()
                    .unwrap_or(0);
                let name = std::path::Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                println!(
                    "{name}\tspine={} paragraphs={paragraphs} chars={chars} empty={empty} titled={titled} longest={longest}",
                    chapters.len()
                );
            }
            Err(error) => println!("{path}\tERROR {error}"),
        }
    }
}
