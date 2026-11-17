//! Model-output decoding, ported from `tools/verify_onnx.py` via
//! `src/lib/biocn/decode.ts`:
//! - BMES tagging -> subword spans -> words (with char offsets into the text)
//! - POS argmax per row
//! - DEP heads (see [`crate::eisner`]) + relation argmax gathered at each head

use crate::analysis::eisner::decode_dep_heads;
use crate::analysis::resources::BioCNResources;
use crate::analysis::roles::Dep;
use crate::analysis::utf16::from_utf16;

/// One decoded word: just the text. Its position in the sentence died with the
/// old Word.start/end — nothing ever read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word {
    pub text: String,
}

/// argmax over `len` floats starting at `offset` (first max wins, like NaN
/// never being greater than `best` in JS).
#[inline]
fn argmax(arr: &[f32], offset: usize, len: usize) -> usize {
    let mut best = f32::NEG_INFINITY;
    let mut arg = 0;
    for i in 0..len {
        let v = arr[offset + i];
        if v > best {
            best = v;
            arg = i;
        }
    }
    arg
}

/// TOK logits `[S, 4]` -> words. `offs` comes from
/// [`crate::analysis::resources::tok_prep`] (subword char ranges over the text;
/// normalization is 1:1 so the same offsets index the original).
pub fn decode_words(
    text: &[u16],
    offs: &[(usize, usize)],
    res: &BioCNResources,
    logits: &[f32],
) -> Vec<Word> {
    let n = offs.len();
    let ntags = res.tok_tags.len();
    let mut tags: Vec<&str> = Vec::with_capacity(n);
    for i in 0..n {
        tags.push(&res.tok_tags[argmax(logits, (1 + i) * ntags, ntags)]);
    }

    // BMES -> subword index spans
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < n {
        match tags[i] {
            "S" => {
                spans.push((i, i + 1));
                i += 1;
            }
            "B" => {
                let mut j = i + 1;
                while j < n && (tags[j] == "M" || tags[j] == "B") {
                    j += 1;
                }
                if j < n && tags[j] == "E" {
                    j += 1;
                }
                spans.push((i, j));
                i = j;
            }
            // stray E/M -> single
            _ => {
                spans.push((i, i + 1));
                i += 1;
            }
        }
    }

    // subword spans -> char spans -> words sliced from the original text
    let mut words = Vec::with_capacity(spans.len());
    for (s0, s1) in spans {
        let a = offs[s0].0;
        let b = offs[s1 - 1].1;
        if b > a {
            words.push(Word {
                text: from_utf16(&text[a..b]),
            });
        }
    }
    words
}

/// POS logits `[N, tagCount]` -> one tag per row (rows == words).
pub fn decode_pos(res: &BioCNResources, logits: &[f32], n_words: usize) -> Vec<String> {
    let ntags = res.pos_tags.len();
    (0..n_words)
        .map(|r| res.pos_tags[argmax(logits, r * ntags, ntags)].clone())
        .collect()
}

/// DEP heads + relations. `s_arc` `[L, L]` row-major, `s_rel` `[L, L, R]`
/// row-major, `L = n_words + 1` (row 0 = root). `heads[d-1]` = argmax row
/// (eisner fallback); `rel(d)` = argmax over `s_rel[d][heads[d-1]]`.
pub fn decode_dep(res: &BioCNResources, s_arc: &[f32], s_rel: &[f32], n_words: usize) -> Vec<Dep> {
    let l = n_words + 1;
    let r = res.rel_labels.len();
    let heads = decode_dep_heads(s_arc, n_words);
    let mut deps = Vec::with_capacity(n_words);
    for d in 1..=n_words {
        let h = heads[d - 1] as usize;
        let rel = argmax(s_rel, (d * l + h) * r, r);
        deps.push(Dep {
            head: h as i32,
            deprel: res.rel_labels[rel].clone(),
        });
    }
    deps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argmax_first_max_wins() {
        let v = [f32::NEG_INFINITY, 1.0, 1.0, 0.5];
        assert_eq!(argmax(&v, 0, 4), 1);
    }
}
