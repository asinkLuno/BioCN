//! Dumps sentence splits for a corpus file, one JSON line per paragraph.
//! Usage: cargo run --example splitdump -- <in.txt> <out.tsv>
use std::io::Write;

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let text = std::fs::read_to_string(&args[1]).unwrap();
    let mut file = std::io::BufWriter::new(std::fs::File::create(&args[2]).unwrap());
    let mut paras = 0usize;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let sents = biocn_lib::text::sentences(line);
        let json = sents
            .iter()
            .map(|s| format!("\"{}\"", json_escape(s)))
            .collect::<Vec<_>>()
            .join(", ");
        writeln!(file, "{}\t[{}]", sents.len(), json).unwrap();
        paras += 1;
    }
    eprintln!("paras {paras}");
}
