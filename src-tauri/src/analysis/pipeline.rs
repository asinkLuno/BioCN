//! bioCN sentence analysis: preprocessing -> ONNX session calls -> decoding
//! -> bioCN 主谓宾 segments. The session runner is injected so tests can run
//! on recorded tensors and the app on ONNX Runtime.
//!
//! Hard limit from `tools/README.md`: a single call may carry at most 510
//! subwords for TOK and 510 words for POS/DEP (the exported graphs have no
//! sliding-window branch — longer inputs index out of bounds). Inputs are
//! chunked below those limits.

use crate::analysis::decode::{Word, decode_dep, decode_pos, decode_words};
pub use crate::analysis::resources::Result as RunnerResult;
use crate::analysis::resources::{BioCNResources, Result, pack_word_rows, tok_prep, words_prep};
use crate::analysis::roles::{Dep, Segment, char_roles, to_segments};
use crate::analysis::utf16::to_utf16;

/// Max subwords fed to TOK per call (`[CLS]` + subs + `[SEP]` <= 510).
pub const MAX_SUBS: usize = 508;
/// Max words fed to POS/DEP per call (<= 510 per README).
pub const MAX_WORDS: usize = 500;

/// The three model calls, injected so the same pipeline runs on
/// ONNX Runtime (Rust) or recorded fixture tensors.
pub trait SessionRunner {
    fn run_tok(&self, input_ids: &[i64], shape: (i64, i64)) -> Result<Vec<f32>>;
    fn run_pos(
        &self,
        input_ids: &[i64],
        ids_shape: (i64, i64),
        token_span: &[i64],
        span_shape: (i64, i64, i64),
    ) -> Result<Vec<f32>>;
    fn run_dep(
        &self,
        input_ids: &[i64],
        ids_shape: (i64, i64),
        token_span: &[i64],
        span_shape: (i64, i64, i64),
        mask: &[u8],
    ) -> Result<(Vec<f32>, Vec<f32>)>;
}

#[derive(Debug, Clone)]
pub struct SentenceAnalysis {
    pub words: Vec<Word>,
    pub pos: Vec<String>,
    pub deps: Vec<Dep>,
    pub segments: Vec<Segment>,
}

/// `analyzeSentence` — full analysis of one sentence.
pub fn analyze_sentence(
    res: &BioCNResources,
    runner: &dyn SessionRunner,
    sentence: &str,
) -> Result<Option<SentenceAnalysis>> {
    let text = to_utf16(sentence);

    // ---- TOK (chunked at the subword limit) -----------------------------
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
        let logits = runner.run_tok(&chunk, shape)?;
        words.extend(decode_words(&text, chunk_offs, res, &logits));
    }
    if words.is_empty() {
        return Ok(None);
    }

    // ---- POS + DEP (chunked at the word limit) --------------------------
    let mut pos: Vec<String> = Vec::new();
    let mut deps: Vec<Dep> = Vec::new();
    let mut w0 = 0;
    while w0 < words.len() {
        let chunk_words: Vec<String> = words[w0..(w0 + MAX_WORDS).min(words.len())]
            .iter()
            .map(|w| w.text.clone())
            .collect();
        let prep2 = words_prep(&chunk_words, res);

        let packed_pos = pack_word_rows(&prep2.ids, &prep2.spans, 0);
        let pos_logits = runner.run_pos(
            &packed_pos.input_ids,
            packed_pos.input_shape,
            &packed_pos.token_span,
            packed_pos.span_shape,
        )?;
        pos.extend(decode_pos(res, &pos_logits, chunk_words.len()));

        let packed_dep = pack_word_rows(&prep2.ids, &prep2.spans, 1);
        // the MODEL gets an all-True mask (root scores stay real); only the
        // decoder mask clears column 0 — decode_dep_heads handles that.
        let all_true = vec![1u8; packed_dep.mask.len()];
        let (s_arc, s_rel) = runner.run_dep(
            &packed_dep.input_ids,
            packed_dep.input_shape,
            &packed_dep.token_span,
            packed_dep.span_shape,
            &all_true,
        )?;
        deps.extend(decode_dep(res, &s_arc, &s_rel, chunk_words.len()));

        w0 += MAX_WORDS;
    }

    let tokens: Vec<String> = words.iter().map(|w| w.text.clone()).collect();
    let roles = char_roles(&text, &tokens, &deps, &pos);
    Ok(Some(SentenceAnalysis {
        words,
        pos,
        deps,
        segments: to_segments(&text, &roles),
    }))
}
