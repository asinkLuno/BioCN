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
    BioCNResources, PackedWords, Result, pack_word_rows, tok_prep, words_prep,
};
use crate::analysis::roles::{Dep, Segment, char_roles, to_segments};
use crate::analysis::utf16::to_utf16;

/// Max subwords fed to TOK per call (`[CLS]` + subs + `[SEP]` <= 510).
pub const MAX_SUBS: usize = 508;
/// Max words fed to POS/DEP per call (<= 510 per README).
pub const MAX_WORDS: usize = 500;

/// One DEP chunk: the packed tensors plus the word count that produced them.
pub type DepPack = (PackedWords, usize);

/// What stage two hands stage three: the utf16 text, stage one's decoded
/// tokens, their POS tags, and one pack per word chunk.
pub type PosBundle = (Vec<u16>, Vec<String>, Vec<String>, Vec<DepPack>);

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
        let logits = sessions.run_tok(&chunk, shape)?;
        words.extend(decode_words(&text, chunk_offs, res, &logits));
    }
    if words.is_empty() {
        return Ok(None);
    }
    Ok(Some((text, words)))
}

/// Stage two: the POS graph. Wordpieces the words stage one decoded, runs
/// every word chunk through the graph, decodes the tags — and packs the DEP
/// tensors alongside, so stage three only has to run and decode. The text is
/// carried through unchanged; stage three needs it for the char offsets.
pub fn pos_stage(
    res: &BioCNResources,
    sessions: &Sessions,
    text: Vec<u16>,
    words: Vec<Word>,
) -> Result<PosBundle> {
    let mut pos: Vec<String> = Vec::new();
    let mut packs: Vec<(PackedWords, usize)> = Vec::new();
    let mut w0 = 0;
    while w0 < words.len() {
        let chunk_words: Vec<String> = words[w0..(w0 + MAX_WORDS).min(words.len())]
            .iter()
            .map(|w| w.text.clone())
            .collect();
        let prep2 = words_prep(&chunk_words, res);

        let packed_pos = pack_word_rows(&prep2.ids, &prep2.spans, 0);
        let pos_logits = sessions.run_pos(
            &packed_pos.input_ids,
            packed_pos.input_shape,
            &packed_pos.token_span,
            packed_pos.span_shape,
        )?;
        pos.extend(decode_pos(res, &pos_logits, chunk_words.len()));

        // the MODEL gets an all-True mask (root scores stay real); only the
        // decoder mask clears column 0 — decode_dep_heads handles that. The
        // mask is built at run time in stage three.
        let packed_dep = pack_word_rows(&prep2.ids, &prep2.spans, 1);
        packs.push((packed_dep, chunk_words.len()));

        w0 += MAX_WORDS;
    }

    let tokens: Vec<String> = words.iter().map(|w| w.text.clone()).collect();
    Ok((text, tokens, pos, packs))
}

/// Stage three: the DEP graph. Runs the tensors stage two packed, decodes
/// heads (Eisner) and relations, and reads the 主谓宾 spans off the original
/// sentence text. May be empty — a sentence the models parsed but found no
/// 主谓宾 in still colors as "analyzed, nothing to paint".
pub fn dep_stage(
    res: &BioCNResources,
    sessions: &Sessions,
    text: Vec<u16>,
    tokens: Vec<String>,
    pos: Vec<String>,
    packs: Vec<(PackedWords, usize)>,
) -> Result<Vec<Segment>> {
    let mut deps: Vec<Dep> = Vec::new();
    for (packed, chunk_len) in packs {
        let all_true = vec![1u8; packed.mask.len()];
        let (s_arc, s_rel) = sessions.run_dep(
            &packed.input_ids,
            packed.input_shape,
            &packed.token_span,
            packed.span_shape,
            &all_true,
        )?;
        deps.extend(decode_dep(res, &s_arc, &s_rel, chunk_len));
    }

    let roles = char_roles(&text, &tokens, &deps, &pos);
    Ok(to_segments(&text, &roles))
}
