//! BioCN model resources: vocab / normalization table / label lists.
//!
//! Mirrors `src/lib/biocn/resources.ts`. File-format quirks (see
//! `tools/README.md`):
//! - `vocab.txt` MUST be split on `"\n"`, not on universal newlines: it
//!   contains U+2028 as a token itself, and splitlines()-style parsing shifts
//!   every later vocab id.
//! - `normalize.json` maps one char to one char (1:1, length-preserving), so
//!   normalized-text offsets equal original-text offsets.

use std::collections::HashMap;

use crate::analysis::utf16::to_utf16;

pub const CLS: i64 = 101;
pub const SEP: i64 = 102;
/// `[UNK]` — id used when a wordpiece somehow is not in the vocab.
const UNK_ID: i64 = 100;

pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone)]
pub struct BioCNResources {
    pub vocab: HashMap<String, u32>,
    pub normalize: HashMap<char, char>,
    /// BMES label order = model output channel order, e.g. ["B", "E", "S", "M"]
    pub tok_tags: Vec<String>,
    pub pos_tags: Vec<String>,
    pub rel_labels: Vec<String>,
}

/// Split `vocab.txt` on `"\n"` only and drop the trailing empty line.
pub fn parse_vocab(text: &str) -> HashMap<String, u32> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
        .into_iter()
        .enumerate()
        .map(|(i, w)| (w.to_string(), i as u32))
        .collect()
}

fn parse_normalize(json: &str) -> Result<HashMap<char, char>> {
    let raw: HashMap<String, String> = serde_json::from_str(json)?;
    let mut out = HashMap::with_capacity(raw.len());
    for (k, v) in raw {
        // JS indexes this map by a single UTF-16 unit, so multi-unit keys can
        // never match there either; skip them instead of pretending otherwise.
        let (mut kc, mut vc) = (k.chars(), v.chars());
        if let (Some(k1), None, Some(v1), None) = (kc.next(), kc.next(), vc.next(), vc.next()) {
            out.insert(k1, v1);
        }
    }
    Ok(out)
}

fn parse_list(json: &str) -> Result<Vec<String>> {
    Ok(serde_json::from_str(json)?)
}

impl BioCNResources {
    /// Parse the five resource files shipped next to the models.
    pub fn parse(
        vocab_txt: &str,
        normalize_json: &str,
        tok_tags_json: &str,
        pos_tags_json: &str,
        rel_labels_json: &str,
    ) -> Result<Self> {
        Ok(Self {
            vocab: parse_vocab(vocab_txt),
            normalize: parse_normalize(normalize_json)?,
            tok_tags: parse_list(tok_tags_json)?,
            pos_tags: parse_list(pos_tags_json)?,
            rel_labels: parse_list(rel_labels_json)?,
        })
    }

    /// Load `vocab.txt`, `normalize.json`, `tok_tags.json`, `pos_tags.json`
    /// and `dep_rel_labels.json` from a directory.
    pub fn load_dir(dir: &std::path::Path) -> Result<Self> {
        let read = |name: &str| -> Result<String> { Ok(std::fs::read_to_string(dir.join(name))?) };
        Self::parse(
            &read("vocab.txt")?,
            &read("normalize.json")?,
            &read("tok_tags.json")?,
            &read("pos_tags.json")?,
            &read("dep_rel_labels.json")?,
        )
    }

    /// 1:1 per-character normalization (length-preserving, UTF-16 safe).
    pub fn normalize_text(&self, text: &[u16]) -> Vec<u16> {
        let mut out = Vec::with_capacity(text.len());
        let mut i = 0;
        while i < text.len() {
            let c = text[i];
            match char::from_u32(c as u32).and_then(|ch| self.normalize.get(&ch)) {
                Some(to) => {
                    let mut buf = [0u16; 2];
                    out.extend_from_slice(to.encode_utf16(&mut buf));
                }
                None => out.push(c),
            }
            i += 1;
        }
        out
    }

    #[inline]
    fn id(&self, sub: &str) -> i64 {
        self.vocab.get(sub).map(|id| *id as i64).unwrap_or(UNK_ID)
    }
}

/// `[CLS]` + subword ids + `[SEP]` + each subword's char range.
pub struct TokPrep {
    pub ids: Vec<i64>,
    pub offs: Vec<(usize, usize)>,
}

pub fn tok_prep(text: &[u16], res: &BioCNResources) -> TokPrep {
    let normalized = res.normalize_text(text);
    let groups = crate::analysis::tokenizer::encode(&normalized, &res.vocab);
    let mut ids = Vec::with_capacity(groups.len() + 2);
    ids.push(CLS);
    for g in &groups {
        ids.push(res.id(&g.sub));
    }
    ids.push(SEP);
    TokPrep {
        ids,
        offs: groups.into_iter().map(|g| (g.start, g.end)).collect(),
    }
}

/// Per-word wordpiece for POS/DEP: `ids` = concat of each word's subwords,
/// `spans[t]` = absolute positions of word `t`'s subwords in `ids` (no CLS
/// shift here — the +1 for CLS happens in [`pack_word_rows`]).
pub struct WordsPrep {
    pub ids: Vec<i64>,
    pub spans: Vec<Vec<usize>>,
}

pub fn words_prep(words: &[String], res: &BioCNResources) -> WordsPrep {
    let mut ids: Vec<i64> = Vec::new();
    let mut spans: Vec<Vec<usize>> = Vec::with_capacity(words.len());
    for w in words {
        let normalized = res.normalize_text(&to_utf16(w));
        let mut span: Vec<usize> = Vec::new();
        for g in crate::analysis::tokenizer::encode(&normalized, &res.vocab) {
            span.push(ids.len());
            ids.push(res.id(&g.sub));
        }
        spans.push(span);
    }
    WordsPrep { ids, spans }
}

/// Word-level tensors, packed exactly like `verify_onnx.py` `_pack` (batch 1).
#[derive(Debug, Clone)]
pub struct PackedWords {
    /// int64 [1, S] — `[CLS]` + ids + `[SEP]`, 0-padded
    pub input_ids: Vec<i64>,
    pub input_shape: (i64, i64),
    /// int64 [1, N, K] — span rows (+1 CLS shift), row 0 = root for DEP
    pub token_span: Vec<i64>,
    pub span_shape: (i64, i64, i64),
    /// [1, N] real-token mask (the decoder mask clears column 0 itself)
    pub mask: Vec<u8>,
}

/// `root_rows` = 1 for DEP (row 0 is the root pointing at CLS), 0 for POS.
pub fn pack_word_rows(ids: &[i64], spans: &[Vec<usize>], root_rows: usize) -> PackedWords {
    let s = ids.len() + 2;
    let n = spans.len() + root_rows;
    let k = spans.iter().map(|sp| sp.len()).max().unwrap_or(0).max(1);

    let mut input_ids = vec![0i64; s];
    input_ids[0] = CLS;
    input_ids[ids.len() + 1] = SEP;
    input_ids[1..1 + ids.len()].copy_from_slice(ids);

    let mut token_span = vec![0i64; n * k];
    for (t, span) in spans.iter().enumerate() {
        let row = root_rows + t;
        for (j, pos) in span.iter().enumerate() {
            token_span[row * k + j] = (*pos as i64) + 1; // +1 for CLS
        }
    }

    let mut mask = vec![0u8; n];
    for t in 0..spans.len() {
        mask[root_rows + t] = 1;
    }

    PackedWords {
        input_ids,
        input_shape: (1, s as i64),
        token_span,
        span_shape: (1, n as i64, k as i64),
        mask,
    }
}
