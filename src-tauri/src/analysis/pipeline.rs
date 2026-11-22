//! BioCN sentence analysis: preprocessing -> ONNX session calls -> decoding
//! -> BioCN 主谓宾 segments. The three model calls live on the `Sessions`
//! side (engine.rs); if a test ever needs to replay recorded tensors instead
//! of running ONNX, re-introduce a runner trait there — no mock exists yet,
//! so the indirection was removed as dead weight.
//!
//! One sentence walks three graphs in order — TOK, POS, DEP — and each walk
//! exists exactly once, as [`tok_stage`], [`pos_stage`] and [`dep_stage`]:
//! [`analyze_all`] streams sentences through them on one dedicated thread per
//! graph. There is no serial driver left — the pipeline is the only mode.
//!
//! Hard limit from `tools/README.md`: a single call may carry at most 510
//! subwords for TOK and 510 words for POS/DEP (the exported graphs have no
//! sliding-window branch — longer inputs index out of bounds). Inputs are
//! chunked below those limits.

use std::sync::mpsc;

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

/// `(index, answer)` pairs a stage reports for the sentences it finished,
/// FIFO over its slice of the input.
type StageDone = Vec<(usize, SentenceAnswer)>;

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


/// Every sentence of `sentences` through the three graphs, answers back in
/// input order.
///
/// The three graphs sit on three dedicated threads with bounded queues
/// between them: each stage owns its session outright, so no session mutex
/// is ever contended. Measured on desktop (9700X, int8): the graphs take
/// 31%/31%/37% of a serial sentence and the pure-Rust glue under 1%, so the
/// pipeline's throughput is capped by the DEP stage and lands right under
/// that cap — ~390 sentences/s versus ~140 serial, at a lower thread count
/// than worker parallelism would need for the same rate.
///
/// A stage failure is that sentence's failure alone: it comes back as `Err`
/// and the stream moves on. `Ok(None)` marks a sentence with nothing to
/// color. Queue depth is small on purpose — it bounds the memory a slow
/// downstream stage can build up, and measured latency, not throughput, is
/// what a deeper queue would buy.
pub fn analyze_all<'s>(
    res: &BioCNResources,
    sessions: &Sessions,
    sentences: &[&'s str],
) -> Vec<(&'s str, SentenceAnswer)> {
    if sentences.is_empty() {
        return Vec::new();
    }

    // Each stage owns one answer vec and writes only sentences it finished —
    // a sentence's answer comes from exactly one stage, whichever stops
    // carrying it. Scoped threads borrow all three; the caller is a blocking
    // thread that has nothing else to do until the join anyway.
    let mut tok_done: StageDone = Vec::new();
    let mut pos_done: StageDone = Vec::new();
    let mut dep_done: StageDone = Vec::new();

    std::thread::scope(|scope| {
        let res = &res;
        let sessions = &sessions;
        let tok_done = &mut tok_done;
        let pos_done = &mut pos_done;
        let dep_done = &mut dep_done;
        let (tok_tx, tok_rx) = mpsc::sync_channel::<(usize, Vec<u16>, Vec<Word>)>(4);
        let (dep_tx, dep_rx) =
            mpsc::sync_channel::<(usize, Vec<u16>, Vec<String>, Vec<String>, Vec<(PackedWords, usize)>)>(4);

        // Stage one: sentence -> words. Empty sentences never leave it.
        scope.spawn(move || {
            for (index, sentence) in sentences.iter().enumerate() {
                match tok_stage(res, sessions, sentence) {
                    Ok(Some((text, words))) => {
                        if tok_tx.send((index, text, words)).is_err() {
                            return;
                        }
                    }
                    Ok(None) => tok_done.push((index, Ok(None))),
                    Err(error) => tok_done.push((index, Err(error.to_string()))),
                }
            }
        });

        // Stage two: words -> POS tags + packed DEP tensors.
        scope.spawn(move || {
            for (index, text, words) in tok_rx.iter() {
                match pos_stage(res, sessions, text, words) {
                    Ok((text, tokens, pos, packs)) => {
                        if dep_tx.send((index, text, tokens, pos, packs)).is_err() {
                            return;
                        }
                    }
                    Err(error) => pos_done.push((index, Err(error.to_string()))),
                }
            }
        });

        // Stage three: DEP scores -> eisner -> 主谓宾 segments.
        scope.spawn(move || {
            for (index, text, tokens, pos, packs) in dep_rx.iter() {
                let answer =
                    dep_stage(res, sessions, text, tokens, pos, packs).map_err(|e| e.to_string());
                dep_done.push((index, answer.map(Some)));
            }
        });
    });

    // Each stage's vec is FIFO over its own slice of the sentences, so all
    // three are ascending by index and every sentence lands in exactly one
    // slot; a gap would mean a stage dropped a sentence, which no path above
    // does.
    let mut finished: Vec<Option<SentenceAnswer>> =
        (0..sentences.len()).map(|_| None).collect();
    for (index, answer) in tok_done {
        finished[index] = Some(answer);
    }
    for (index, answer) in pos_done {
        finished[index] = Some(answer);
    }
    for (index, answer) in dep_done {
        finished[index] = Some(answer);
    }
    finished
        .into_iter()
        .enumerate()
        .map(|(index, slot)| {
            let answer = slot.unwrap_or_else(|| {
                panic!("analyze_all: sentence {index} never reached a final stage")
            });
            (sentences[index], answer)
        })
        .collect()
}
