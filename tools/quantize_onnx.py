"""Quantize the exported ONNX models for Android.

Two variants per model, one directory per variant (filenames unchanged so
verify_onnx.py and the Android side can swap a model dir):
  - models/int8/ : dynamic int8 weight quantization (MatMul/Gemm -> int8,
    per-channel weights, activations fp32). ~2.3x smaller, ~35% faster on CPU.
  - models/fp16/ : fp16 storage (keep_io_types=True so inputs/outputs stay
    fp32/int64). Exactly 2x smaller, near-lossless; ORT CPU upcasts on load,
    so the win is download/storage size, not compute speed.

Measured on the verify corpus (23 adversarial sentences):
  - fp16: tok 23/23, pos 210/210, dep 209/210 (1 ambiguous edge flip)
  - int8: tok 23/23, pos 208/210, dep 199/210 — drift comes from the ELECTRA
    encoder itself; keeping the dep scoring heads in fp32 (nodes_to_exclude)
    was tested and changed nothing.

Usage:
    uv run python quantize_onnx.py
    uv run python verify_onnx.py models/int8    # check accuracy of a variant
"""

from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnxruntime.quantization import QuantType, quantize_dynamic
from onnxruntime.transformers import float16

HERE = Path(__file__).parent
MODELS_DIR = HERE / "models"

NAMES = ["tok", "pos", "dep"]


def int8_quantize(src: Path, dst: Path) -> None:
    quantize_dynamic(
        str(src), str(dst),
        op_types_to_quantize=["MatMul", "Gemm"],
        per_channel=True,
        weight_type=QuantType.QInt8,
    )


def fp16_convert(src: Path, dst: Path) -> None:
    converted = float16.convert_float_to_float16(
        onnx.load(str(src)), keep_io_types=True)
    onnx.save(converted, str(dst))


def _io_signature(sess):
    """(name, type) for every input and output, in declaration order."""
    return [(x.name, x.type) for x in (*sess.get_inputs(), *sess.get_outputs())]


def validate_variant(src: Path, dst: Path) -> None:
    """Run the variant once on a short dynamic-shape input and compare it with
    fp32: a frozen axis or a dropped output shows up here, not on device.
    Loading the session is also the ONNX validity check."""
    ref = ort.InferenceSession(str(src), providers=["CPUExecutionProvider"])
    quant = ort.InferenceSession(str(dst), providers=["CPUExecutionProvider"])
    if _io_signature(ref) != _io_signature(quant):
        raise RuntimeError(f"io signature changed: {dst}")
    # One token per row; the dep graph adds a root row at index 0, so its span
    # points at subword 0 while pos's points at subword 1. Building the dict by
    # name also drops token_span/mask for the tok graph, which takes neither.
    dep = any(x.name == "mask" for x in quant.get_inputs())
    feeds = {
        "input_ids": np.array([[101, 200, 102]], dtype=np.int64),
        "token_span": np.array([[[0], [1]]] if dep else [[[1]]], dtype=np.int64),
        "mask": np.ones((1, 2), dtype=np.bool_),
    }
    feeds = {x.name: feeds[x.name] for x in quant.get_inputs()}
    expected = ref.run(None, feeds)
    for name, a, b in zip((x.name for x in quant.get_outputs()), expected,
                          quant.run(None, feeds), strict=True):
        if a.shape != b.shape:
            raise RuntimeError(f"{name} shape changed for {dst}: {a.shape} != {b.shape}")
        if not np.isfinite(b).all():
            raise RuntimeError(f"{name} contains non-finite values in {dst}")
    print(f"    validated io signature + dynamic inference: {dst}")


def size_mb(p: Path) -> float:
    return p.stat().st_size / 1e6


def main():
    for name in NAMES:
        src = MODELS_DIR / f"biocn_{name}.onnx"
        print(f"=== [{name}] fp32 {size_mb(src):.0f} MB")
        for tag, fn in (("int8", int8_quantize), ("fp16", fp16_convert)):
            out_dir = MODELS_DIR / tag
            out_dir.mkdir(exist_ok=True)
            dst = out_dir / f"biocn_{name}.onnx"
            fn(src, dst)
            validate_variant(src, dst)
            print(f"    {tag}: {size_mb(dst):.1f} MB  ({dst})")
    print("done. Run `uv run python verify_onnx.py models/int8` / models/fp16 "
          "to check accuracy.")


if __name__ == "__main__":
    main()
