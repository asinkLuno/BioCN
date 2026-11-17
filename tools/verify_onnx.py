"""End-to-end verification: standalone preprocessing + ONNX inference + decoding
vs the full HanLP pipeline, on a stress corpus.

This validates exactly what the Android app must reimplement:
  1. text normalization (normalize.json table)
  2. HF-style basic tokenization + wordpiece (vocab.txt) -> input_ids
     (+ token_span / mask), matching hanlp's exact tensor conventions
  3. ONNX inference (biocn_{tok,pos,dep}.onnx)
  4. decoding (BMES spans -> char offsets -> words, argmax POS, eisner dep)

Ground truth = `hanlp.load(...)` full pipeline outputs on the same corpus.
Step 1+2 are asserted directly against the tensors hanlp fed its torch models
(captured via a forward hook, one sentence per call to avoid batch sorting).
"""

import json
import sys
import unicodedata
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
import hanlp

from export_onnx import spy_forward

HERE = Path(__file__).parent
# Optional argv[1]: a model-variant dir (e.g. models/int8) holding only the
# .onnx files; vocab/labels/normalize tables are shared and always read from
# models/.
MODELS = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "models"
AUX = HERE / "models"

CLS, SEP, PAD = 101, 102, 0


# ------------------------------------------------------------ HF tokenizer
def _is_whitespace(ch):
    if ch in (" ", "\t", "\n", "\r"):
        return True
    return unicodedata.category(ch) == "Zs"


def _is_control(ch):
    if ch in ("\t", "\n", "\r"):
        return False
    return unicodedata.category(ch).startswith("Cc") or \
        unicodedata.category(ch).startswith("Cf")


def _is_punctuation(cp):
    if (33 <= cp <= 47) or (58 <= cp <= 64) or (91 <= cp <= 96) or (123 <= cp <= 126):
        return True
    return unicodedata.category(chr(cp)).startswith("P")


def _is_chinese_char(cp):
    return (0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF or
            0x20000 <= cp <= 0x2A6DF or 0x2A700 <= cp <= 0x2B73F or
            0x2B740 <= cp <= 0x2B81F or 0x2B820 <= cp <= 0x2CEAF or
            0xF900 <= cp <= 0xFAFF or 0x2F800 <= cp <= 0x2FA1F)


def _strip_accents(s):
    s = unicodedata.normalize("NFD", s)
    return unicodedata.normalize("NFC", "".join(
        c for c in s if unicodedata.category(c) != "Mn"))


def wordpiece_strs(word, vocab):
    """HF greedy longest-match wordpiece, returning the piece strings."""
    out, start = [], 0
    while start < len(word):
        end = len(word)
        found = None
        while start < end:
            sub = word[start:end]
            if start > 0:
                sub = "##" + sub
            if sub in vocab:
                found = sub
                break
            end -= 1
        if found is None:
            return ["[UNK]"]
        out.append(found)
        start = end
    return out


def basic_pieces(text):
    """HF BertTokenizer basic tokenization (do_lower_case=True, accents
    stripped, CJK/punct split out). Returns (piece, char_start, char_end)
    with char ranges referring to the input `text` string."""
    pieces, cur = [], []  # cur: list of (char, index)

    def flush():
        if cur:
            s = _strip_accents("".join(c for c, _ in cur))
            pieces.append((s, cur[0][1], cur[-1][1] + 1))
            cur.clear()

    for i, ch in enumerate(text):
        cp = ord(ch)
        if _is_whitespace(ch) or _is_control(ch):
            flush()
        elif _is_chinese_char(cp) or _is_punctuation(cp):
            flush()
            pieces.append((ch, i, i + 1))
        else:
            cur.append((ch.lower(), i))
    flush()
    return pieces


def encode(text, vocab):
    """Tokenize `text` the way HF BertTokenizerFast would, keeping char
    offsets. Returns [(subword, char_start, char_end), ...] — one entry per
    wordpiece, char ranges over the input string. [UNK] spans the whole piece.
    """
    out = []
    for piece, a, b in basic_pieces(text):
        strs = wordpiece_strs(piece, vocab)
        if strs == ["[UNK]"]:
            out.append(("[UNK]", a, b))
            continue
        pos = a
        for s in strs:
            n = len(s) - (2 if s.startswith("##") else 0)
            out.append((s, pos, pos + n))
            pos += n
    return out


# ---------------------------------------------------------------- pipeline
class BioCNOnnx:
    def __init__(self):
        # NOTE: split('\n') not splitlines() — the vocab contains U+2028 as a
        # token itself, which splitlines() treats as a line break and shifts
        # every later index (HF's readlines() behaves like split('\n')).
        lines = (AUX / "vocab.txt").read_text(encoding="utf-8").split("\n")
        assert lines.pop() == "", "vocab.txt must end with a newline"
        self.vocab = {w: i for i, w in enumerate(lines)}
        self.normalize = json.loads((AUX / "normalize.json").read_text(encoding="utf-8"))
        self.tok_tags = json.loads((AUX / "tok_tags.json").read_text())
        self.pos_tags = json.loads((AUX / "pos_tags.json").read_text())
        self.rel_labels = json.loads((AUX / "dep_rel_labels.json").read_text())
        so = ort.SessionOptions()
        so.intra_op_num_threads = 4
        self.s_tok = ort.InferenceSession(str(MODELS / "biocn_tok.onnx"), so, ["CPUExecutionProvider"])
        self.s_pos = ort.InferenceSession(str(MODELS / "biocn_pos.onnx"), so, ["CPUExecutionProvider"])
        self.s_dep = ort.InferenceSession(str(MODELS / "biocn_dep.onnx"), so, ["CPUExecutionProvider"])

    def norm(self, s):
        return "".join(self.normalize.get(c, c) for c in s)

    # ---- preprocessing (Android spec)
    def tok_inputs(self, texts):
        """TOK: hanlp tokenizes the full (normalized) text with the HF
        tokenizer; every SUBWORD is a tagging unit. input_ids = [CLS] +
        subwords + [SEP], 0-padded; we keep each subword's char range over the
        normalized text (same indices as the original, normalization is 1:1)
        for mapping predicted spans back to the original string."""
        ids_rows, offs_rows = [], []
        for text in texts:
            groups = encode(self.norm(text), self.vocab)
            ids_rows.append([CLS] + [self.vocab[s] for s, _, _ in groups] + [SEP])
            offs_rows.append([(a, b) for _, a, b in groups])
        L = max(len(x) for x in ids_rows)
        ids = np.array([r + [PAD] * (L - len(r)) for r in ids_rows], dtype=np.int64)
        return ids, offs_rows

    def pos_inputs(self, token_lists):
        """POS: one entry per word; token_span[b, n, :K] holds the absolute
        subword positions of word n (0-padded), K = max subwords per word."""
        ids, span, _ = self._pack(token_lists, n_root_rows=0)
        return ids, span

    def dep_inputs(self, token_lists):
        """DEP: token_span[b, t, :K] = subword positions of word t (0-padded,
        same convention as POS); row 0 is the root ([CLS] rep). The returned
        mask marks real token rows — for the MODEL use an all-True mask."""
        return self._pack(token_lists, n_root_rows=1)

    def _pack(self, token_lists, n_root_rows):
        """Word-level tensors: per-sentence subword ids + each word's subword
        positions, padded to the batch's longest sentence, word and word
        length. `n_root_rows` shifts the word rows down to leave the DEP graph
        its root row."""
        rows = []
        for tokens in token_lists:
            ids, spans = [], []
            for t in tokens:
                groups = encode(self.norm(t), self.vocab)
                spans.append(list(range(len(ids), len(ids) + len(groups))))
                ids.extend(self.vocab[s] for s, _, _ in groups)
            rows.append((ids, spans))
        B = len(rows)
        S = max(len(f) for f, _ in rows) + 2  # + [CLS], [SEP]
        N = max(len(spans) for _, spans in rows) + n_root_rows
        K = max(len(s) for _, spans in rows for s in spans)
        ids = np.zeros((B, S), dtype=np.int64)
        span = np.zeros((B, N, K), dtype=np.int64)
        mask = np.zeros((B, N), dtype=bool)
        for b, (flat, spans) in enumerate(rows):
            ids[b, 0], ids[b, len(flat) + 1] = CLS, SEP
            ids[b, 1:len(flat) + 1] = flat
            for t, s in enumerate(spans, start=n_root_rows):
                span[b, t, :len(s)] = [p + 1 for p in s]  # +1 for CLS
            mask[b, n_root_rows:n_root_rows + len(spans)] = True
        return ids, span, mask

    # ---- inference + decode
    def tokenize(self, texts):
        ids, offs_rows = self.tok_inputs(texts)
        logits = self.s_tok.run(None, {"input_ids": ids})[0]
        out = []
        for b, text in enumerate(texts):
            offs = offs_rows[b]
            n = len(offs)
            tags = [self.tok_tags[int(np.argmax(logits[b, 1 + i]))] for i in range(n)]
            # BMES -> subword index spans
            spans, i = [], 0
            while i < n:
                t = tags[i]
                if t == "S":
                    spans.append((i, i + 1)); i += 1
                elif t == "B":
                    j = i + 1
                    while j < n and tags[j] in ("M", "B"):
                        j += 1
                    if j < n and tags[j] == "E":
                        j += 1
                    spans.append((i, j)); i = j
                else:  # stray E/M -> single
                    spans.append((i, i + 1)); i += 1
            # subword spans -> char spans -> original text
            words = []
            for s0, s1 in spans:
                a = offs[s0][0]
                e = offs[s1 - 1][1]
                words.append(text[a:e])
            out.append(words)
        return out

    def pos_tag(self, token_lists):
        ids, span = self.pos_inputs(token_lists)
        logits = self.s_pos.run(None, {"input_ids": ids, "token_span": span})[0]
        return [[self.pos_tags[int(np.argmax(logits[b, n]))]
                 for n in range(len(toks))]
                for b, toks in enumerate(token_lists)]

    def parse_dep(self, token_lists):
        from hanlp.components.parsers.alg import decode_dep
        ids, span, mask = self.dep_inputs(token_lists)
        # hanlp predict-time convention (feed_batch): the MODEL gets an
        # all-True mask (root scores stay real); only the DECODER mask has
        # column 0 cleared (mask[:, 0] = 0). Feeding the cleared mask to the
        # model would -inf out the root column and break tree decoding.
        s_arc, s_rel = self.s_dep.run(None, {
            "input_ids": ids, "token_span": span, "mask": np.ones_like(mask)})
        arc_preds = decode_dep(torch.from_numpy(s_arc), torch.from_numpy(mask),
                               tree=True, proj=True)
        rel_preds = torch.from_numpy(s_rel).argmax(-1).gather(
            -1, arc_preds.unsqueeze(-1)).squeeze(-1)
        out = []
        for b, toks in enumerate(token_lists):
            n = len(toks)
            heads = arc_preds[b, 1:n + 1].tolist()
            rels = [self.rel_labels[r] for r in rel_preds[b, 1:n + 1].tolist()]
            out.append([{"head": h, "deprel": r} for h, r in zip(heads, rels)])
        return out


# ---------------------------------------------------------------- checks
def check_inputs_vs_hanlp(pipeline, comps, texts, gt_tok):
    """Assert our preprocessing reproduces hanlp's tensors byte-for-byte."""
    tok_comp, pos_comp, dep_comp = comps
    ok = True
    # NOTE: one sentence per call — hanlp's SortingSampler batches by length,
    # so rows of a multi-sentence batch don't match input order.

    calls = _capture_calls(tok_comp, [[t] for t in texts])
    my_tok_in = [pipeline.tok_inputs([t]) for t in texts]
    ok &= _report("tok input_ids", all(
        mine[0][0].tolist() == box[0][1][0].tolist()
        for mine, box in zip(my_tok_in, calls)))

    calls = _capture_calls(pos_comp, [[w] for w in gt_tok])
    my_pos_in = [pipeline.pos_inputs([w]) for w in gt_tok]
    ok &= _report("pos input_ids+span", all(
        mine[0][0].tolist() == box[0][1][0].tolist()
        and mine[1][0].tolist() == box[0][2][0].tolist()
        for mine, box in zip(my_pos_in, calls)))

    calls = _capture_calls(dep_comp, [[w] for w in gt_tok])
    my_dep_in = [pipeline.dep_inputs([w]) for w in gt_tok]
    ok &= _report("dep inputs", all(
        mine[0][0].tolist() == box[1]["input_ids"][0].tolist()
        and mine[1][0].tolist() == box[1]["token_span"][0].tolist()
        and mine[2][0].tolist() == box[1]["mask"][0].tolist()
        for mine, box in zip(my_dep_in, calls)))
    return ok


def _capture_calls(comp, samples):
    """model.forward's (args, kwargs) for one call per sample, in call order."""
    with spy_forward(comp) as calls:
        for sample in samples:
            comp(sample)
    return calls


def _report(name, cond):
    print(f"    [{'PASS' if cond else 'FAIL'}] {name}")
    return cond


TEXTS = [
    "小明吃了一个苹果。",
    "他被老师批评了。",
    "妈妈把房间打扫得干干净净。",
    "这本书非常有意思。",
    "我昨天买了三本书，然后回家看了两本。",
    "2026年，人工智能会更加普及。",
    "他用GitHub管理代码，效率提高了不少。",
    "Ｈｅｌｌｏ Ｗｏｒｌｄ！",
    "这篇文章写了很久很久很久，一直没有写完……",
    "龘是一个非常生僻的字。",
    "被雨淋湿的孩子们跑回了家。",
    "他把那封信撕碎了。",
    "天黑了，星星出来了，月亮也出来了。",
    "明天要下雨。",
    "好！",
    "《红楼梦》是中国古典文学的巅峰之作，作者曹雪芹呕心沥血十年才完成这部巨著，"
    "书中塑造了几百个栩栩如生的人物形象，至今仍被读者津津乐道。",
    "老师叫我们做作业。",
    "我看见他进了教室，然后坐下，拿出书来读。",
    "中国人在北京过春节。",
    "手机没电了。",
    "这道菜咸得让人受不了。",
    "大家一致认为这是一个好主意。",
    " weather is nice today。",
]


def show_diff(mine, gt):
    print(f"      onnx : {mine}")
    print(f"      hanlp: {gt}")


def main():
    tok = hanlp.load(hanlp.pretrained.tok.COARSE_ELECTRA_SMALL_ZH, devices=-1)
    pos = hanlp.load(hanlp.pretrained.pos.CTB9_POS_ELECTRA_SMALL, devices=-1)
    dep = hanlp.load(hanlp.pretrained.dep.CTB9_DEP_ELECTRA_SMALL, devices=-1)
    pipeline = BioCNOnnx()

    # ground truth: hanlp tokenization (feeds pos/dep everywhere below)
    gt_tok = tok(TEXTS)

    print("== 1. preprocessing parity vs hanlp-captured tensors ==")
    ok = check_inputs_vs_hanlp(pipeline, (tok, pos, dep), TEXTS, gt_tok)
    if not ok:
        print("!! preprocessing mismatch — see above/fix before trusting the rest")

    print("== 2. end-to-end decode vs hanlp pipeline ==")
    gt_pos = pos(gt_tok)
    gt_dep = dep(gt_tok)

    my_tok = pipeline.tokenize(TEXTS)
    my_pos = pipeline.pos_tag(gt_tok)
    my_dep = pipeline.parse_dep(gt_tok)

    n_tok_bad = sum(a != b for a, b in zip(my_tok, gt_tok))
    n_pos_bad = sum(a != b for a, b in zip(my_pos, gt_pos))
    n_dep_bad = sum(m["head"] != r.head or m["deprel"] != r.deprel
                    for mine, ref in zip(my_dep, gt_dep)
                    for m, r in zip(mine, ref))

    total_tok = len(gt_tok)
    total_pos = sum(len(x) for x in gt_pos)
    lengths_match = (len(my_tok) == len(gt_tok) and len(my_pos) == len(gt_pos)
                     and len(my_dep) == len(gt_dep))
    if not lengths_match:
        print(f"    output count mismatch: tok {len(my_tok)}/{len(gt_tok)}, "
              f"pos {len(my_pos)}/{len(gt_pos)}, dep {len(my_dep)}/{len(gt_dep)}")
    print(f"    tok : {total_tok - n_tok_bad}/{total_tok} sentences match")
    print(f"    pos : {total_pos - n_pos_bad}/{total_pos} tokens match")
    print(f"    dep : {total_pos - n_dep_bad}/{total_pos} (head,rel) pairs match")

    for i, (m, g) in enumerate(zip(my_tok, gt_tok)):
        if m != g:
            print(f"    tok diff [{i}] {TEXTS[i][:24]}:")
            show_diff(m, g)
    for i, (m, g) in enumerate(zip(my_pos, gt_pos)):
        if m != g:
            print(f"    pos diff [{i}] {TEXTS[i][:24]}:")
            show_diff(m, g)
    for i, (m, g) in enumerate(zip(my_dep, gt_dep)):
        for j, (mm, rr) in enumerate(zip(m, g)):
            if mm["head"] != rr.head or mm["deprel"] != rr.deprel:
                print(f"    dep diff [{i}] {gt_tok[i][j]}: onnx={mm} hanlp=({rr.head},{rr.deprel})")

    all_ok = lengths_match and ok and n_tok_bad == 0 and n_pos_bad == 0 and n_dep_bad == 0
    print("== RESULT:", "ALL PASS" if all_ok else "FAILURES")
    if not all_ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
