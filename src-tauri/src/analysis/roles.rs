//! Port of BioCN `src/analyzer.py` role mapping (MIT, vendored at
//! `tools/ref/biocn_analyzer.py`): dependency relations -> 主谓宾 char roles.
//!
//! `nsubj`/`top` -> subject; `root`/`dep`/`conj`/`ccomp`/`xcomp`/`rcomp`
//! (verb-ish POS) -> predicate; `dobj`/`range`/`attr` -> object. Passives
//! surface their subject via `nsubjpass`; 把字句 splits agent/patient on the
//! `ba` marker; attributive relations never reach the core roles.

use std::collections::HashSet;

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
fn reachable_core(rels: &[String], heads: &[i32]) -> Vec<usize> {
    let n = heads.len();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); n + 1];
    for (i, &head) in heads.iter().enumerate() {
        let h = head.max(0) as usize;
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
        if !PRED_RELS.contains(&rels[i].as_str()) {
            continue;
        }
        is_pred[i] = true;
        preds.push(i);
        stack.extend(children[i + 1].iter().copied());
    }
    preds
}

/// Predicate candidates: POS-verbish tokens reachable from the root.
fn reachable_pred_idxs(rels: &[String], heads: &[i32], pos_tags: &[String]) -> Vec<usize> {
    reachable_core(rels, heads)
        .into_iter()
        .filter(|i| VERB_POS.contains(&pos_tags[*i].as_str()))
        .collect()
}

fn in_set(set: &[&str], s: &str) -> bool {
    set.contains(&s)
}

/// 把字句: agent and post-把 patient are both nsubj; `ba` splits them.
fn ba_roles(rels: &[String], heads: &[i32], preds: &[usize]) -> (Vec<usize>, Vec<usize>) {
    let ba = rels
        .iter()
        .position(|r| r == "ba")
        .map(|i| i as i32)
        .unwrap_or(-1);
    let pred_set: HashSet<usize> = preds.iter().copied().collect();
    let mut subjs = Vec::new();
    let mut objs = Vec::new();
    for (i, rel) in rels.iter().enumerate() {
        if !in_set(&SUBJ_RELS, rel) {
            continue;
        }
        let h = heads[i] - 1;
        if h < 0 || !pred_set.contains(&(h as usize)) {
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

fn rel_candidates(rels: &[String], heads: &[i32], preds: &[usize], set: &[&str]) -> Vec<usize> {
    let pred_set: HashSet<usize> = preds.iter().copied().collect();
    let mut cands = Vec::new();
    for (i, rel) in rels.iter().enumerate() {
        if in_set(set, rel) && heads[i] > 0 && pred_set.contains(&((heads[i] - 1) as usize)) {
            cands.push(i);
        }
    }
    cands
}

fn sv_roles(rels: &[String], heads: &[i32], preds: &[usize]) -> (Vec<usize>, Vec<usize>) {
    if rels.iter().any(|r| r == "nsubjpass") {
        // 被动句: only the passive subject; the 施事 in the 被-phrase is not one.
        return (
            rels.iter()
                .enumerate()
                .filter(|(_, r)| *r == "nsubjpass")
                .map(|(i, _)| i)
                .collect(),
            Vec::new(),
        );
    }
    if rels.iter().any(|r| r == "ba") {
        return ba_roles(rels, heads, preds);
    }
    (
        rel_candidates(rels, heads, preds, &SUBJ_RELS),
        rel_candidates(rels, heads, preds, &OBJ_RELS),
    )
}

/// BioCN `_token_spans` + `_fill_roles`: per-character roles for one
/// sentence, predicate > subject > object priority.
pub fn char_roles(
    sentence: &[u16],
    tokens: &[String],
    deps: &[Dep],
    pos_tags: &[String],
) -> Vec<Role> {
    let mut roles = vec![Role::Normal; sentence.len()];
    if tokens.is_empty() {
        return roles;
    }
    let starts = token_char_starts(sentence, tokens);

    let rels: Vec<String> = deps.iter().map(|d| d.deprel.clone()).collect();
    let heads: Vec<i32> = deps.iter().map(|d| d.head).collect();
    let preds = reachable_pred_idxs(&rels, &heads, pos_tags);
    let (subjs, objs) = sv_roles(&rels, &heads, &preds);

    let groups: [(Role, &Vec<usize>); 3] = [
        (Role::Subject, &subjs),
        (Role::Object, &objs),
        (Role::Predicate, &preds),
    ];
    for (role, idxs) in groups {
        for &ti in idxs {
            if ti >= starts.len() || ti >= tokens.len() {
                continue;
            }
            let begin = starts[ti];
            let end = begin + crate::analysis::utf16::utf16_len(&tokens[ti]);
            for slot in roles.iter_mut().take(end.min(sentence.len())).skip(begin) {
                if role.priority() > slot.priority() {
                    *slot = role;
                }
            }
        }
    }
    roles
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
}
