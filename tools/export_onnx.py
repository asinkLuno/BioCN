"""Export BioCN's three HanLP models (TOK/POS/DEP) to Android-ready ONNX.

Models (all chinese-electra-180g-small-discriminator backbones, no CRF):
  - tok: coarse_electra_small_zh   -> per-subword BMES logits [B, S, 4]
  - pos: ctb9_pos_electra_small    -> per-token CTB9 POS logits [B, N, 37]
  - dep: ctb9_dep_electra_small    -> biaffine s_arc [B, L, L] + s_rel [B, L, L, 46]

Trace inputs are captured by hooking each component's real predict call, so the
export always matches HanLP's own dataset conventions. See README.md for the
interface spec. All sequences must be <= 510 chars/tokens per call (the exported
graph is the non-sliding-window branch); chunk longer sentences in the app.

Usage:
    uv run python export_onnx.py            # export all three
    uv run python export_onnx.py tok dep    # export a subset
"""

import contextlib
import json
import sys
from pathlib import Path

import torch
import torch.nn as nn
import hanlp
import onnxruntime as ort

OUT_DIR = Path(__file__).parent / "models"
OPSET = 17

# (name, model id, trace sample, input_names, output_names, dynamic_axes)
JOBS = [
    ("tok", hanlp.pretrained.tok.COARSE_ELECTRA_SMALL_ZH,
     ["小明吃了一个苹果。", "他被老师批评了。"],
     ["lens", "input_ids"], ["logits"],
     {"lens": {0: "batch"},
      "input_ids": {0: "batch", 1: "subword_len"},
      "logits": {0: "batch", 1: "subword_len"}}),
    ("pos", hanlp.pretrained.pos.CTB9_POS_ELECTRA_SMALL,
     [["小明", "吃", "一个", "红苹果", "。"], ["他", "被", "老师", "批评", "了", "。"]],
     ["lens", "input_ids", "token_span"], ["logits"],
     {"lens": {0: "batch"},
      "input_ids": {0: "batch", 1: "subword_len"},
      "token_span": {0: "batch", 1: "token_len", 2: "max_subwords"},
      "logits": {0: "batch", 1: "token_len"}}),
    ("dep", hanlp.pretrained.dep.CTB9_DEP_ELECTRA_SMALL,
     [["小明", "吃", "一个", "红苹果", "。"], ["他", "被", "老师", "批评", "了", "。"]],
     ["input_ids", "token_span", "mask"], ["s_arc", "s_rel"],
     {"input_ids": {0: "batch", 1: "subword_len"},
      "token_span": {0: "batch", 1: "token_len", 2: "max_subwords"},
      "mask": {0: "batch", 1: "token_len"},
      "s_arc": {0: "batch", 1: "token_len", 2: "token_len"},
      "s_rel": {0: "batch", 1: "token_len", 2: "token_len"}}),
]

# (name, vocabulary key, side-car file) — one label list per model, in the
# channel order the graph emits.
LABELS = {
    "tok": ("tag", "tok_tags.json"),
    "pos": ("tag", "pos_tags.json"),
    "dep": ("rel", "dep_rel_labels.json"),
}


class TaggingWrapper(nn.Module):
    """(lens, input_ids[, token_span]) -> (logits,). Drops the mask output.

    Signature mirrors TransformerTaggingModel.forward so a captured call can be
    replayed; `lens` only feeds the dropped mask, so the tracer prunes it. A
    1-tuple keeps every wrapper's return arity identical.
    """

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, lens, input_ids, token_span=None):
        logits, _ = self.model(lens, input_ids, token_span)
        return (logits,)


class DepWrapper(nn.Module):
    """(input_ids, token_span, mask) -> (s_arc, s_rel)."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, input_ids, token_span, mask):
        s_arc, s_rel = self.model(
            input_ids=input_ids, token_span=token_span, mask=mask,
            words=None, feats=None, lens=None,
        )
        return s_arc, s_rel


def capture_forward_args(comp, sample):
    """Run `comp` on `sample`, returning the (args, kwargs) it fed
    model.forward — i.e. the exact tensors HanLP builds, in its convention."""
    with spy_forward(comp) as calls:
        comp(sample)
    return calls[0]


@contextlib.contextmanager
def spy_forward(comp):
    """Collect every (args, kwargs) the component feeds model.forward inside
    the block — the ground truth for what our preprocessing must reproduce."""
    orig = comp.model.forward
    calls = []

    def spy(*args, **kwargs):
        calls.append((args, kwargs))
        return orig(*args, **kwargs)

    comp.model.forward = spy
    try:
        yield calls
    finally:
        comp.model.forward = orig


def export(name, comp_id, sample, input_names, output_names, dynamic_axes):
    print(f"=== [{name}] loading {comp_id}")
    comp = hanlp.load(comp_id, devices=-1)
    comp.model.eval()

    args, kwargs = capture_forward_args(comp, sample)
    if name == "dep":
        wrapper = DepWrapper(comp.model)
        trace_args = (kwargs["input_ids"], kwargs["token_span"], kwargs["mask"])
    else:
        wrapper = TaggingWrapper(comp.model)
        # one trace arg per declared input: tok stops at input_ids, pos also
        # takes the span (the captured call carries two trailing Nones)
        trace_args = args[:len(input_names)]

    out_path = OUT_DIR / f"biocn_{name}.onnx"
    with torch.no_grad():
        torch.onnx.export(
            wrapper, trace_args, out_path,
            opset_version=OPSET,
            input_names=input_names,
            output_names=output_names,
            dynamic_axes=dynamic_axes,
            dynamo=False,
        )
    wrapper.eval()  # torch 2.9 tracer flips the module back to train mode
    print(f"    exported -> {out_path}")

    _export_side_files(comp, name)
    _smoke_test(wrapper, trace_args, input_names, output_names, out_path)


def _export_side_files(comp, name):
    # Shared by all three models (same backbone / same normalizer), so each
    # export run rewrites them with identical bytes.
    comp.transformer_tokenizer.save_vocabulary(str(OUT_DIR))
    # Character normalization table, applied to input text before tokenization
    table = comp.config["transform"]._table
    (OUT_DIR / "normalize.json").write_text(
        json.dumps(table, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"    normalize table: {len(table)} entries")
    # Decoding label list (order matters: index == model output index)
    vocab_key, fname = LABELS[name]
    labels = list(comp.vocabs[vocab_key].idx_to_token)
    (OUT_DIR / fname).write_text(
        json.dumps(labels, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"    {vocab_key} labels ({len(labels)}): {labels[:6]}...")


def _smoke_test(wrapper, trace_args, input_names, output_names, out_path):
    """Compare the exported graph with the torch wrapper: first on the trace
    inputs, then on their first row alone (a batch axis frozen by tracing shows
    up as a shape or value mismatch)."""
    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    # Feed the graph exactly what it declares, looked up by name: `lens` was
    # pruned from the tok/pos graphs (it only fed the dropped mask), so a
    # graph asking for something the trace never produced fails here.
    traced = {name: arg.numpy() for name, arg in zip(input_names, trace_args)}
    feeds = {i.name: traced[i.name] for i in sess.get_inputs()}
    print(f"    session inputs: {list(feeds)}")

    _assert_matches(wrapper, trace_args, sess, feeds, output_names, "trace")
    _assert_matches(
        wrapper, tuple(a[:1] for a in trace_args), sess,
        {k: v[:1] for k, v in feeds.items()}, output_names, "batch=1")


def _assert_matches(wrapper, args, sess, feeds, output_names, label):
    with torch.no_grad():
        ref = wrapper(*args)
    for name, expected, actual in zip(output_names, ref, sess.run(None, feeds), strict=True):
        if tuple(expected.shape) != tuple(actual.shape):
            raise RuntimeError(f"{label} {name}: shape {actual.shape} != {tuple(expected.shape)}")
        # isclose, not equality: the -inf masked arc scores must compare equal
        if not torch.isclose(torch.from_numpy(actual), expected, rtol=1e-3, atol=1e-4).all():
            raise RuntimeError(f"{label} {name}: ONNX output differs from torch")
        print(f"    smoke {label} {name}: OK")


def main():
    OUT_DIR.mkdir(exist_ok=True)
    which = sys.argv[1:] or [name for name, *_ in JOBS]
    for name, comp_id, sample, in_names, out_names, axes in JOBS:
        if name in which:
            export(name, comp_id, sample, in_names, out_names, axes)
    print("done.")


if __name__ == "__main__":
    main()
