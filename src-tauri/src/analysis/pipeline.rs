//! BioCN sentence analysis stages: preprocessing -> ONNX session calls ->
//! decoding -> BioCN 主谓宾 segments.
//!
//! One sentence walks three graphs in order — TOK, POS, DEP — implemented once
//! as [`tok_stage`], [`pos_stage`] and [`dep_stage`] and driven by the
//! persistent three-stage priority scheduler in [`crate::analysis::scheduler`].
//!
//! Hard limit from `tools/README.md`: a single call may carry at most 510
//! subwords for TOK and 510 words for POS/DEP (the exported graphs have no
//! sliding-window branch — longer inputs index out of bounds). Inputs are
//! chunked below those limits.

use crate::analysis::decode::{Word, decode_dep, decode_pos, decode_words};
use crate::analysis::engine::Sessions;
use crate::analysis::resources::{
    BioCNResources, PackedWords, Result, WordsPrep, pack_word_rows, tok_prep,
};
use crate::analysis::roles::{Dep, Segment, char_roles_from_spans, to_segments};
use crate::analysis::utf16::to_utf16;

/// Max subwords fed to BERT per call (`[CLS]` + subs + `[SEP]` <= 510).
pub const MAX_SUBS: usize = 508;
/// Max words fed to POS/DEP per call (<= 510 per README).
pub const MAX_WORDS: usize = 500;

/// One DEP chunk: packed tensors plus the global word offset and count so
/// chunk-local dependency heads can be shifted back into sentence space.
pub struct DepChunk {
    pub packed: PackedWords,
    pub word_offset: usize,
    pub word_count: usize,
}

/// What stage two hands stage three: the utf16 text, stage one's word spans,
/// their POS tags, and one packed DEP chunk per window.
pub struct PosBundle {
    pub text: Vec<u16>,
    pub word_spans: Vec<(usize, usize)>,
    pub pos: Vec<String>,
    pub chunks: Vec<DepChunk>,
}

/// One sentence's final answer: `Ok(Some(..))` carries the 主谓宾 segments,
/// `Ok(None)` marks "analyzed, nothing to paint", `Err` fails that one
/// sentence alone.
pub type SentenceAnswer = std::result::Result<Option<Vec<Segment>>, String>;

/// Stage one: the TOK graph. Tokenizes `sentence`, runs every subword chunk
/// through the graph, decodes the words. `None` means there is nothing to
/// color — empty input, or input that decodes to no words.
pub fn tok_stage(
    res: &BioCNResources,
    sessions: &Sessions,
    sentence: &str,
) -> Result<Option<(Vec<u16>, Vec<Word>)>> {
    let text = to_utf16(sentence);
    let prep = tok_prep(&text, res);
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

        let shape = (1, chunk.len() as i64);
        let logits = sessions.run_tok(chunk, shape)?;
        words.extend(decode_words(&text, chunk_offs, res, &logits)?);
    }
    if words.is_empty() {
        return Ok(None);
    }
    Ok(Some((text, words)))
}

/// Splits `words` into POS/DEP windows honoring BOTH BERT's `max_subs` subword
/// ceiling and `max_words` word ceiling. Returns `(word_offset, prep)` tuples.
fn chunk_words_for_bert(
    words: &[Word],
    res: &BioCNResources,
    max_words: usize,
    max_subs: usize,
) -> Vec<(usize, WordsPrep)> {
    let mut chunks = Vec::new();
    let mut cur_offset = 0usize;
    let mut cur_ids: Vec<i64> = Vec::new();
    let mut cur_spans: Vec<(usize, usize)> = Vec::new();

    for (idx, word) in words.iter().enumerate() {
        let mut sub_ids = res.word_subword_ids(&word.text);
        if sub_ids.len() > max_subs {
            sub_ids.truncate(max_subs);
        }
        let would_exceed = !cur_spans.is_empty()
            && (cur_spans.len() >= max_words || cur_ids.len() + sub_ids.len() > max_subs);
        if would_exceed {
            chunks.push((
                cur_offset,
                WordsPrep {
                    ids: std::mem::take(&mut cur_ids),
                    spans: std::mem::take(&mut cur_spans),
                },
            ));
            cur_offset = idx;
        }
        let start = cur_ids.len();
        cur_ids.extend_from_slice(&sub_ids);
        cur_spans.push((start, cur_ids.len()));
    }

    if !cur_spans.is_empty() {
        chunks.push((
            cur_offset,
            WordsPrep {
                ids: cur_ids,
                spans: cur_spans,
            },
        ));
    }
    chunks
}

/// Shifts non-root dependency heads from chunk-local 1-based indices into the
/// sentence's global 1-based word index space.
fn shift_chunk_deps(deps: &mut [Dep], word_offset: usize) {
    if word_offset == 0 {
        return;
    }
    let shift = word_offset as i32;
    for dep in deps {
        if dep.head > 0 {
            dep.head += shift;
        }
    }
}

/// Stage two: the POS graph. Wordpieces the words stage one decoded, runs
/// every word/subword-bounded chunk through the graph, decodes the tags — and
/// packs the DEP tensors alongside, so stage three only has to run and decode.
pub fn pos_stage(
    res: &BioCNResources,
    sessions: &Sessions,
    text: Vec<u16>,
    words: Vec<Word>,
) -> Result<PosBundle> {
    let mut pos: Vec<String> = Vec::with_capacity(words.len());
    let mut chunks: Vec<DepChunk> = Vec::new();

    for (word_offset, prep2) in chunk_words_for_bert(&words, res, MAX_WORDS, MAX_SUBS) {
        let word_count = prep2.spans.len();
        let packed_pos = pack_word_rows(&prep2.ids, &prep2.spans, 0);
        let pos_logits = sessions.run_pos(
            packed_pos.input_ids,
            packed_pos.input_shape,
            packed_pos.token_span,
            packed_pos.span_shape,
        )?;
        pos.extend(decode_pos(res, &pos_logits, word_count)?);

        // the MODEL gets an all-True mask (root scores stay real); only the
        // decoder mask clears column 0 — decode_dep_heads handles that.
        let packed_dep = pack_word_rows(&prep2.ids, &prep2.spans, 1);
        chunks.push(DepChunk {
            packed: packed_dep,
            word_offset,
            word_count,
        });
    }

    let word_spans = words.into_iter().map(|w| (w.start, w.end)).collect();
    Ok(PosBundle {
        text,
        word_spans,
        pos,
        chunks,
    })
}

/// Stage three: the DEP graph. Runs the tensors stage two packed, decodes
/// heads (Eisner) and relations, shifts multi-chunk heads into sentence space,
/// and reads the 主谓宾 spans off the original sentence text.
pub fn dep_stage(
    res: &BioCNResources,
    sessions: &Sessions,
    bundle: PosBundle,
) -> Result<Vec<Segment>> {
    let PosBundle {
        text,
        word_spans,
        pos,
        chunks,
    } = bundle;
    let mut deps: Vec<Dep> = Vec::with_capacity(word_spans.len());
    for chunk in chunks {
        let mut chunk_deps = sessions.run_dep_with(
            chunk.packed.input_ids,
            chunk.packed.input_shape,
            chunk.packed.token_span,
            chunk.packed.span_shape,
            chunk.packed.row_count,
            |s_arc, s_rel| decode_dep(res, s_arc, s_rel, chunk.word_count),
        )?;
        shift_chunk_deps(&mut chunk_deps, chunk.word_offset);
        deps.extend(chunk_deps);
    }

    let roles = char_roles_from_spans(text.len(), &word_spans, &deps, &pos);
    Ok(to_segments(&text, &roles))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_resources() -> BioCNResources {
        BioCNResources::parse(
            "[PAD]\n大\n学\n生\n",
            "{}",
            r#"["B","M","E","S"]"#,
            r#"["NN","VV"]"#,
            r#"["root","nsubj"]"#,
        )
        .unwrap()
    }

    #[test]
    fn chunk_words_respects_subword_budget_as_well_as_word_budget() {
        let res = test_resources();
        // Each word has 3 CJK chars = 3 subwords; with max_subs = 7 and
        // max_words = 500, at most 2 words (6 subwords) fit per chunk.
        let words: Vec<Word> = (0..5)
            .map(|i| Word {
                text: "大学生".into(),
                start: i * 3,
                end: (i + 1) * 3,
            })
            .collect();
        let chunks = chunk_words_for_bert(&words, &res, 500, 7);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].0, 0);
        assert_eq!(chunks[0].1.spans.len(), 2);
        assert_eq!(chunks[0].1.ids.len(), 6);
        assert_eq!(chunks[1].0, 2);
        assert_eq!(chunks[1].1.spans.len(), 2);
        assert_eq!(chunks[2].0, 4);
        assert_eq!(chunks[2].1.spans.len(), 1);
    }

    #[test]
    fn shift_chunk_deps_offsets_non_root_heads_and_preserves_roots() {
        let mut deps = vec![
            Dep {
                head: 2,
                deprel: "nsubj".into(),
            },
            Dep {
                head: 0,
                deprel: "root".into(),
            },
            Dep {
                head: 2,
                deprel: "dobj".into(),
            },
        ];
        shift_chunk_deps(&mut deps, 10);
        assert_eq!(deps[0].head, 12);
        assert_eq!(deps[1].head, 0);
        assert_eq!(deps[2].head, 12);
    }
}
