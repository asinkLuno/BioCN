//! Model-output decoding, ported from `tools/verify_onnx.py` via
//! `src/lib/biocn/decode.ts`:
//! - BMES tagging -> subword spans -> words (with char offsets into the text)
//! - POS argmax per row
//! - DEP heads (see [`crate::eisner`]) + relation argmax gathered at each head

use crate::analysis::eisner::decode_dep_heads;
use crate::analysis::resources::{BioCNResources, Result};
use crate::analysis::roles::Dep;
use crate::analysis::utf16::from_utf16;

/// One decoded word with its exact UTF-16 span `[start, end)` in the sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word {
    pub text: String,
    pub start: usize,
    pub end: usize,
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
) -> Result<Vec<Word>> {
    let n = offs.len();
    let ntags = res.tok_tags.len();
    if ntags == 0 {
        return Err("tok_tags is empty".into());
    }
    let need = (1 + n).checked_mul(ntags).ok_or("tok logits size overflow")?;
    if logits.len() < need {
        return Err(format!("tok logits too short: got {}, need >= {need}", logits.len()).into());
    }

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
        let a = offs[s0].0.min(text.len());
        let b = offs[s1 - 1].1.min(text.len());
        if b > a {
            words.push(Word {
                text: from_utf16(&text[a..b]),
                start: a,
                end: b,
            });
        }
    }
    Ok(words)
}

/// POS logits `[N, tagCount]` -> one tag per row (rows == words).
pub fn decode_pos(res: &BioCNResources, logits: &[f32], n_words: usize) -> Result<Vec<String>> {
    let ntags = res.pos_tags.len();
    if ntags == 0 {
        return Err("pos_tags is empty".into());
    }
    let need = n_words.checked_mul(ntags).ok_or("pos logits size overflow")?;
    if logits.len() < need {
        return Err(format!("pos logits too short: got {}, need >= {need}", logits.len()).into());
    }
    Ok((0..n_words)
        .map(|r| res.pos_tags[argmax(logits, r * ntags, ntags)].clone())
        .collect())
}

/// DEP heads + relations. `s_arc` `[L, L]` row-major, `s_rel` `[L, L, R]`
/// row-major, `L = n_words + 1` (row 0 = root). `heads[d-1]` = argmax row
/// (eisner fallback); `rel(d)` = argmax over `s_rel[d][heads[d-1]]`.
pub fn decode_dep(
    res: &BioCNResources,
    s_arc: &[f32],
    s_rel: &[f32],
    n_words: usize,
) -> Result<Vec<Dep>> {
    if n_words == 0 {
        return Ok(Vec::new());
    }
    let l = n_words + 1;
    let r = res.rel_labels.len();
    if r == 0 {
        return Err("rel_labels is empty".into());
    }
    let need_arc = l.checked_mul(l).ok_or("dep s_arc size overflow")?;
    let need_rel = need_arc.checked_mul(r).ok_or("dep s_rel size overflow")?;
    if s_arc.len() < need_arc {
        return Err(format!("dep s_arc too short: got {}, need >= {need_arc}", s_arc.len()).into());
    }
    if s_rel.len() < need_rel {
        return Err(format!("dep s_rel too short: got {}, need >= {need_rel}", s_rel.len()).into());
    }

    let heads = decode_dep_heads(s_arc, n_words);
    let mut deps = Vec::with_capacity(n_words);
    for d in 1..=n_words {
        let h = (heads[d - 1].max(0) as usize).min(n_words);
        let rel = argmax(s_rel, (d * l + h) * r, r);
        deps.push(Dep {
            head: h as i32,
            deprel: res.rel_labels[rel].clone(),
        });
    }
    Ok(deps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::utf16::to_utf16;

    fn test_resources() -> BioCNResources {
        BioCNResources::parse(
            "[PAD]\n小\n明\n吃\n",
            "{}",
            r#"["B","M","E","S"]"#,
            r#"["NR","VV"]"#,
            r#"["root","nsubj"]"#,
        )
        .unwrap()
    }

    #[test]
    fn argmax_first_max_wins() {
        let v = [f32::NEG_INFINITY, 1.0, 1.0, 0.5];
        assert_eq!(argmax(&v, 0, 4), 1);
    }

    #[test]
    fn decode_words_merges_bmes_and_preserves_utf16_spans() {
        let res = test_resources();
        let text = to_utf16("小明吃");
        let offs = [(0, 1), (1, 2), (2, 3)];
        // CLS row + B, E, S
        let logits = [
            0.0, 0.0, 0.0, 0.0, // CLS
            1.0, 0.0, 0.0, 0.0, // B
            0.0, 0.0, 1.0, 0.0, // E
            0.0, 0.0, 0.0, 1.0, // S
        ];
        let words = decode_words(&text, &offs, &res, &logits).unwrap();
        assert_eq!(
            words,
            vec![
                Word {
                    text: "小明".into(),
                    start: 0,
                    end: 2
                },
                Word {
                    text: "吃".into(),
                    start: 2,
                    end: 3
                },
            ]
        );
    }

    #[test]
    fn decode_rejects_truncated_tensors_instead_of_panicking() {
        let res = test_resources();
        let text = to_utf16("小明");
        assert!(decode_words(&text, &[(0, 1), (1, 2)], &res, &[0.0; 4]).is_err());
        assert!(decode_pos(&res, &[0.0; 1], 2).is_err());
        assert!(decode_dep(&res, &[0.0; 2], &[0.0; 10], 2).is_err());
        assert!(decode_dep(&res, &[0.0; 9], &[0.0; 4], 2).is_err());
    }
}
