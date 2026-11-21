//! Exact Rust port of the HF-BERT tokenizer used by the BioCN models
//! (reference: `tools/verify_onnx.py` `basic_pieces` / `wordpiece_strs` /
//! `encode`, itself asserted byte-for-byte against HanLP's own tensors).
//!
//! Mirrors `src/lib/biocn/tokenizer.ts`: offsets are UTF-16 code units, so
//! they can be used for DOM ranges directly. Python's reference works in code
//! points; every consumer here (BMES decode -> words -> DOM ranges) stays in
//! UTF-16, so behaviour matches for astral characters too (e.g. 龘).

use std::collections::HashMap;

use unicode_general_category::{GeneralCategory, get_general_category};
use unicode_normalization::UnicodeNormalization;

use crate::analysis::utf16::{next_char, utf16_len};

/// One basic-tokenization piece with its UTF-16 range in the source text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Piece {
    pub piece: String,
    pub start: usize,
    pub end: usize,
}

/// One wordpiece with its UTF-16 range in the source text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sub {
    pub sub: String,
    pub start: usize,
    pub end: usize,
}

#[inline]
fn is_whitespace(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '\n' | '\r')
        || get_general_category(ch) == GeneralCategory::SpaceSeparator
}

#[inline]
fn is_control(ch: char) -> bool {
    if matches!(ch, '\t' | '\n' | '\r') {
        return false;
    }
    matches!(
        get_general_category(ch),
        GeneralCategory::Control | GeneralCategory::Format
    )
}

/// `\p{P}` plus the ASCII punctuation blocks (TS checks the code point ranges
/// first, then falls back to the Unicode category).
#[inline]
fn is_punctuation(cp: u32, ch: char) -> bool {
    (33..=47).contains(&cp)
        || (58..=64).contains(&cp)
        || (91..=96).contains(&cp)
        || (123..=126).contains(&cp)
        || matches!(
            get_general_category(ch),
            GeneralCategory::ConnectorPunctuation
                | GeneralCategory::DashPunctuation
                | GeneralCategory::ClosePunctuation
                | GeneralCategory::FinalPunctuation
                | GeneralCategory::InitialPunctuation
                | GeneralCategory::OtherPunctuation
                | GeneralCategory::OpenPunctuation
        )
}

#[inline]
fn is_chinese_char(cp: u32) -> bool {
    (0x4e00..=0x9fff).contains(&cp)
        || (0x3400..=0x4dbf).contains(&cp)
        || (0x20000..=0x2a6df).contains(&cp)
        || (0x2a700..=0x2b73f).contains(&cp)
        || (0x2b740..=0x2b81f).contains(&cp)
        || (0x2b820..=0x2ceaf).contains(&cp)
        || (0xf900..=0xfaff).contains(&cp)
        || (0x2f800..=0x2fa1f).contains(&cp)
}

/// NFD -> drop combining marks (`\p{Mn}`) -> NFC.
fn strip_accents(s: &str) -> String {
    s.nfd()
        .filter(|c| get_general_category(*c) != GeneralCategory::NonspacingMark)
        .collect::<String>()
        .nfc()
        .collect()
}

/// HF `BertTokenizer` basic tokenization: lowercase, accents stripped,
/// CJK/punctuation split onto their own pieces.
pub fn basic_pieces(text: &[u16]) -> Vec<Piece> {
    let mut pieces: Vec<Piece> = Vec::new();
    // (lowercased text, utf16 start, utf16 width)
    let mut cur: Vec<(String, usize, usize)> = Vec::new();

    let flush = |cur: &mut Vec<(String, usize, usize)>, pieces: &mut Vec<Piece>| {
        if !cur.is_empty() {
            let joined: String = cur.iter().map(|c| c.0.as_str()).collect();
            let piece = strip_accents(&joined);
            let first = &cur[0];
            let last = &cur[cur.len() - 1];
            pieces.push(Piece {
                piece,
                start: first.1,
                end: last.1 + last.2,
            });
            cur.clear();
        }
    };

    let mut i = 0;
    while i < text.len() {
        let (ch, width) = next_char(text, i);
        let cp = ch as u32;
        if is_whitespace(ch) || is_control(ch) {
            flush(&mut cur, &mut pieces);
        } else if is_chinese_char(cp) || is_punctuation(cp, ch) {
            flush(&mut cur, &mut pieces);
            pieces.push(Piece {
                piece: ch.to_string(),
                start: i,
                end: i + width,
            });
        } else {
            let lower: String = ch.to_lowercase().collect();
            cur.push((lower, i, width));
        }
        i += width;
    }
    flush(&mut cur, &mut pieces);
    pieces
}

/// HF greedy longest-match wordpiece; `["[UNK]"]` when no piece matches.
pub fn wordpiece_strs(word: &str, vocab: &HashMap<String, u32>) -> Vec<String> {
    if word.is_empty() {
        return vec!["[UNK]".to_string()];
    }
    // Slice on char boundaries: candidates that would split a surrogate pair
    // can never be in the vocab, so char-based shrinking finds the same match
    // as the TS UTF-16-based loop.
    let chars: Vec<char> = word.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let mut end = chars.len();
        let mut found: Option<String> = None;
        while start < end {
            let sub: String = chars[start..end].iter().collect();
            let candidate = if start > 0 { format!("##{sub}") } else { sub };
            if vocab.contains_key(&candidate) {
                found = Some(candidate);
                break;
            }
            end -= 1;
        }
        match found {
            None => return vec!["[UNK]".to_string()],
            Some(sub) => {
                out.push(sub);
                start = end;
            }
        }
    }
    out
}

/// Wordpiece over `text` keeping char offsets; one entry per subword.
/// `[UNK]` spans the whole basic piece.
pub fn encode(text: &[u16], vocab: &HashMap<String, u32>) -> Vec<Sub> {
    let mut out: Vec<Sub> = Vec::new();
    for Piece {
        piece,
        start: a,
        end: b,
    } in basic_pieces(text)
    {
        let strs = wordpiece_strs(&piece, vocab);
        if strs.len() == 1 && strs[0] == "[UNK]" {
            out.push(Sub {
                sub: "[UNK]".to_string(),
                start: a,
                end: b,
            });
            continue;
        }
        let mut pos = a;
        for s in strs {
            let n = utf16_len(&s) - if s.starts_with("##") { 2 } else { 0 };
            out.push(Sub {
                sub: s,
                start: pos,
                end: pos + n,
            });
            pos += n;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::utf16::to_utf16;

    fn vocab(words: &[&str]) -> HashMap<String, u32> {
        words
            .iter()
            .enumerate()
            .map(|(i, w)| (w.to_string(), i as u32))
            .collect()
    }

    #[test]
    fn splits_cjk_and_punctuation() {
        // CJK chars are their own basic pieces (no cross-char merging).
        let v = vocab(&["小", "明", "吃", "了", "苹", "果", "。"]);
        let subs = encode(&to_utf16("小明吃了苹果。"), &v);
        let got: Vec<&str> = subs.iter().map(|s| s.sub.as_str()).collect();
        assert_eq!(got, ["小", "明", "吃", "了", "苹", "果", "。"]);
        assert_eq!((subs[0].start, subs[0].end), (0, 1));
        assert_eq!((subs[6].start, subs[6].end), (6, 7));
    }

    #[test]
    fn wordpiece_prefers_longest_and_marks_continuations() {
        let v = vocab(&["play", "##ground", "##s", "ing", "##ing"]);
        let subs = encode(&to_utf16("playgrounds ing"), &v);
        let got: Vec<&str> = subs.iter().map(|s| s.sub.as_str()).collect();
        assert_eq!(got, ["play", "##ground", "##s", "ing"]);
        assert_eq!((subs[2].start, subs[2].end), (10, 11));
    }

    #[test]
    fn strips_accents_and_lowercases() {
        let v = vocab(&["cafe", "##s"]);
        let subs = encode(&to_utf16("CAFÉs"), &v);
        assert_eq!(subs[0].sub, "cafe");
        assert_eq!(subs[1].sub, "##s");
        // offsets stay in the ORIGINAL text space
        assert_eq!((subs[1].start, subs[1].end), (4, 5));
    }

    #[test]
    fn unk_spans_the_piece() {
        let v = vocab(&["a"]);
        let subs = encode(&to_utf16("zz"), &v);
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].sub, "[UNK]");
        assert_eq!((subs[0].start, subs[0].end), (0, 2));
    }
}
