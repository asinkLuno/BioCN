//! Port of BioCN `src/analyzer.py` role mapping (MIT, vendored at
//! `tools/ref/biocn_analyzer.py`): dependency relations -> 主谓宾 char roles.
//!
//! `nsubj`/`top` -> subject; `root`/`dep`/`conj`/`ccomp`/`xcomp`/`rcomp`
//! (verb-ish POS) -> predicate; `dobj`/`range`/`attr` -> object. Passives
//! surface their subject via `nsubjpass`; 把字句 splits agent/patient on the
//! `ba` marker; attributive relations never reach the core roles.

use serde::{Deserialize, Serialize};

use crate::analysis::utf16::{find_utf16, from_utf16, to_utf16};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Normal,
    Subject,
    Object,
    Predicate,
}

impl Role {
    /// predicate > subject > object > normal
    pub const fn priority(self) -> u8 {
        match self {
            Role::Normal => 0,
            Role::Object => 1,
            Role::Subject => 2,
            Role::Predicate => 3,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Role::Normal => "normal",
            Role::Subject => "subject",
            Role::Object => "object",
            Role::Predicate => "predicate",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dep {
    pub head: i32,
    pub deprel: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub text: String,
    pub start: usize,
    pub role: Role,
}

const VERB_POS: [&str; 4] = ["VV", "VC", "VE", "VA"];
const PRED_RELS: [&str; 6] = ["root", "dep", "conj", "ccomp", "xcomp", "rcomp"];
const SUBJ_RELS: [&str; 2] = ["nsubj", "top"];
const OBJ_RELS: [&str; 3] = ["dobj", "range", "attr"];

/// Map token indices to char start positions within the sentence.
fn token_char_starts(sentence: &[u16], tokens: &[String]) -> Vec<usize> {
    let mut starts = Vec::with_capacity(tokens.len());
    let mut pos = 0;
    for tok in tokens {
        let needle = to_utf16(tok);
        match find_utf16(sentence, &needle, pos) {
            None => starts.push(pos),
            Some(idx) => {
                starts.push(idx);
                pos = idx + needle.len();
            }
        }
    }
    starts
}

/// Tokens reachable from the root through `PRED_RELS` edges only.
fn reachable_core(rels: &[&str], heads: &[i32]) -> Vec<usize> {
    let n = heads.len();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); n + 1];
    for (i, &head) in heads.iter().enumerate() {
        if head < 0 {
            continue;
        }
        let h = head as usize;
        if h <= n {
            children[h].push(i);
        }
    }

    let mut preds: Vec<usize> = Vec::new();
    let mut is_pred = vec![false; n];
    let mut stack: Vec<usize> = children[0].clone();
    while let Some(i) = stack.pop() {
        if is_pred[i] {
            continue;
        }
        if !PRED_RELS.contains(&rels[i]) {
            continue;
        }
        is_pred[i] = true;
        preds.push(i);
        stack.extend(children[i + 1].iter().copied());
    }
    preds
}

/// Predicate candidates: POS-verbish tokens reachable from the root.
fn reachable_pred_idxs(rels: &[&str], heads: &[i32], pos_tags: &[String]) -> Vec<usize> {
    reachable_core(rels, heads)
        .into_iter()
        .filter(|&i| pos_tags.get(i).is_some_and(|p| VERB_POS.contains(&p.as_str())))
        .collect()
}

fn in_set(set: &[&str], s: &str) -> bool {
    set.contains(&s)
}

/// 把字句: agent and post-把 patient are both nsubj; `ba` splits them.
fn ba_roles(rels: &[&str], heads: &[i32], is_pred: &[bool]) -> (Vec<usize>, Vec<usize>) {
    let ba = rels
        .iter()
        .position(|&r| r == "ba")
        .map(|i| i as i32)
        .unwrap_or(-1);
    let mut subjs = Vec::new();
    let mut objs = Vec::new();
    for (i, &rel) in rels.iter().enumerate() {
        if !in_set(&SUBJ_RELS, rel) {
            continue;
        }
        let h = heads[i] - 1;
        if h < 0 || !is_pred.get(h as usize).copied().unwrap_or(false) {
            continue;
        }
        if (i as i32) < ba {
            subjs.push(i);
        } else {
            objs.push(i);
        }
    }
    (subjs, objs)
}

fn rel_candidates(rels: &[&str], heads: &[i32], is_pred: &[bool], set: &[&str]) -> Vec<usize> {
    let mut cands = Vec::new();
    for (i, &rel) in rels.iter().enumerate() {
        let h = heads[i] - 1;
        if in_set(set, rel) && h >= 0 && is_pred.get(h as usize).copied().unwrap_or(false) {
            cands.push(i);
        }
    }
    cands
}

fn sv_roles(rels: &[&str], heads: &[i32], is_pred: &[bool]) -> (Vec<usize>, Vec<usize>) {
    if rels.contains(&"nsubjpass") {
        // 被动句: only the passive subject; the 施事 in the 被-phrase is not one.
        return (
            rels.iter()
                .enumerate()
                .filter(|(_, r)| **r == "nsubjpass")
                .map(|(i, _)| i)
                .collect(),
            Vec::new(),
        );
    }
    if rels.contains(&"ba") {
        return ba_roles(rels, heads, is_pred);
    }
    (
        rel_candidates(rels, heads, is_pred, &SUBJ_RELS),
        rel_candidates(rels, heads, is_pred, &OBJ_RELS),
    )
}

/// BioCN `_token_spans` + `_fill_roles`: per-character roles for one
/// sentence using precomputed `(start, end)` UTF-16 word spans.
pub fn char_roles_from_spans(
    sentence_len: usize,
    spans: &[(usize, usize)],
    deps: &[Dep],
    pos_tags: &[String],
) -> Vec<Role> {
    let mut roles = vec![Role::Normal; sentence_len];
    if spans.is_empty() || deps.is_empty() {
        return roles;
    }

    let rels: Vec<&str> = deps.iter().map(|d| d.deprel.as_str()).collect();
    let heads: Vec<i32> = deps.iter().map(|d| d.head).collect();
    let preds = reachable_pred_idxs(&rels, &heads, pos_tags);
    let mut is_pred = vec![false; deps.len()];
    for &p in &preds {
        is_pred[p] = true;
    }
    let (subjs, objs) = sv_roles(&rels, &heads, &is_pred);

    let groups: [(Role, &[usize]); 3] = [
        (Role::Subject, &subjs),
        (Role::Object, &objs),
        (Role::Predicate, &preds),
    ];
    for (role, idxs) in groups {
        for &ti in idxs {
            let Some(&(begin, end)) = spans.get(ti) else {
                continue;
            };
            for slot in roles.iter_mut().take(end.min(sentence_len)).skip(begin) {
                if role.priority() > slot.priority() {
                    *slot = role;
                }
            }
        }
    }
    roles
}

/// BioCN `_token_spans` + `_fill_roles`: per-character roles for one
/// sentence, predicate > subject > object priority.
pub fn char_roles(
    sentence: &[u16],
    tokens: &[String],
    deps: &[Dep],
    pos_tags: &[String],
) -> Vec<Role> {
    if tokens.is_empty() {
        return vec![Role::Normal; sentence.len()];
    }
    let starts = token_char_starts(sentence, tokens);
    let spans: Vec<(usize, usize)> = starts
        .into_iter()
        .zip(tokens.iter())
        .map(|(begin, tok)| (begin, begin + crate::analysis::utf16::utf16_len(tok)))
        .collect();
    char_roles_from_spans(sentence.len(), &spans, deps, pos_tags)
}

/// BioCN `_to_segments`: fold the per-char role array into contiguous runs.
pub fn to_segments(sentence: &[u16], roles: &[Role]) -> Vec<Segment> {
    if sentence.is_empty() || roles.is_empty() {
        return Vec::new();
    }
    let mut segs = Vec::new();
    let mut start = 0usize;
    let mut cur = roles[0];
    for i in 1..sentence.len() {
        let r = roles.get(i).copied().unwrap_or(Role::Normal);
        if r != cur {
            segs.push(Segment {
                text: from_utf16(&sentence[start..i]),
                start,
                role: cur,
            });
            start = i;
            cur = r;
        }
    }
    segs.push(Segment {
        text: from_utf16(&sentence[start..]),
        start,
        role: cur,
    });
    segs
}

#[cfg(test)]
mod json_tests {
    use super::*;

    /// The IPC contract with `src/lib/biocn/native.ts`: same `Segment` shape the
    /// wasm path produces, so the caller cannot tell the two apart.
    #[test]
    fn segment_serializes_like_the_typescript_type() {
        let s = Segment {
            text: "他".into(),
            start: 7,
            role: Role::Subject,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({ "text": "他", "start": 7, "role": "subject" })
        );
        assert_eq!(
            serde_json::to_value(Segment {
                text: "学".into(),
                start: 0,
                role: Role::Predicate
            })
            .unwrap(),
            serde_json::json!({ "text": "学", "start": 0, "role": "predicate" })
        );
        assert_eq!(
            serde_json::to_value(Segment {
                text: "。".into(),
                start: 1,
                role: Role::Normal
            })
            .unwrap(),
            serde_json::json!({ "text": "。", "start": 1, "role": "normal" })
        );
    }

    #[test]
    fn char_roles_assigns_svo_ba_and_passive_and_handles_short_pos_tags() {
        let s = to_utf16("小明吃苹果");
        let tokens: Vec<String> = ["小明", "吃", "苹果"].iter().map(|t| t.to_string()).collect();
        let deps = vec![
            Dep { head: 2, deprel: "nsubj".into() },
            Dep { head: 0, deprel: "root".into() },
            Dep { head: 2, deprel: "dobj".into() },
        ];
        let pos: Vec<String> = ["NR", "VV", "NN"].iter().map(|t| t.to_string()).collect();
        let segs = to_segments(&s, &char_roles(&s, &tokens, &deps, &pos));
        assert_eq!(
            segs,
            vec![
                Segment { text: "小明".into(), start: 0, role: Role::Subject },
                Segment { text: "吃".into(), start: 2, role: Role::Predicate },
                Segment { text: "苹果".into(), start: 3, role: Role::Object },
            ]
        );

        // 把字句: pre-把 nsubj -> Subject, post-把 nsubj -> Object
        let ba_s = to_utf16("他把书看了");
        let ba_toks: Vec<String> = ["他", "把", "书", "看", "了"].iter().map(|t| t.to_string()).collect();
        let ba_deps = vec![
            Dep { head: 4, deprel: "nsubj".into() },
            Dep { head: 4, deprel: "ba".into() },
            Dep { head: 4, deprel: "nsubj".into() },
            Dep { head: 0, deprel: "root".into() },
            Dep { head: 4, deprel: "asp".into() },
        ];
        let ba_pos: Vec<String> = ["PN", "BA", "NN", "VV", "AS"].iter().map(|t| t.to_string()).collect();
        let ba_roles = char_roles(&ba_s, &ba_toks, &ba_deps, &ba_pos);
        assert_eq!(ba_roles[0], Role::Subject);
        assert_eq!(ba_roles[2], Role::Object);
        assert_eq!(ba_roles[3], Role::Predicate);

        // Short pos_tags must not panic even if deps has more entries.
        let safe = char_roles(&s, &tokens, &deps, &["NR".to_string()]);
        assert_eq!(safe.len(), s.len());
    }
}
