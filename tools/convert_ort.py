"""Convert the quantized ONNX models to ORT format + emit the operator configs.

Why both outputs come from here: the shipped `libonnxruntime.so` is a *minimal
build* (`tools/build_ort_android.py`), which carries only the kernels listed in
the op config and **no ONNX parser at all** — that is where 34 MB → 6 MB comes
from. A minimal build can therefore only load ORT-format models, so this script
also does the conversion that used to happen on device.

  models/int8/biocn_{tok,pos,dep}.ort  省流 variant, what the app loads by default
  models/fp16/biocn_{tok,pos,dep}.ort  高精度 variant (smaller download than int8)
  models/ort_ops.config                union of both, what the .so is built from

Two things decide the flags below:

* `OptimizationStyle.Fixed` folds ORT's graph optimizations (including the int8
  contrib fusions: DynamicQuantizeMatMul, FusedMatMul, …) into the file, and the
  saved graph computes bit-identically to the `.onnx` it came from — asserted
  below. On the fp16 graphs the same style is a trap: ORT dequantizes them back
  to fp32 while optimizing, so the result (137 MB) is twice the fp16 `.onnx` and
  twice the int8 variant.
* `OptimizationStyle.Runtime` keeps fp16 weights as fp16 and defers the
  optimizations to load time (78 MB). Loading such a model requires
  `session.enable_saved_runtime_optimizations=1` (`VARIANTS[...]["saved_opts"]`),
  and only for models we produced ourselves.

The one `.so` we ship has to serve both variants, so the op config it is built
from is the union across every variant. It is written to `models/ort_ops.config`
— the path `build_ort_android.py` reads.

Usage:
    uv run python convert_ort.py            # convert + write the op configs
    uv run python convert_ort.py --force    # even if the .ort files look fresh
    uv run python convert_ort.py --check    # verify only, no writes

ORT's optimizer does not number graph nodes deterministically, so re-running
this on unchanged `.onnx` produces different (equally correct) bytes — which
would make `scripts/sync-models.mjs` re-copy 67 MB of weights on every start.
Conversion therefore only happens when an `.onnx` is newer than its `.ort`.
"""

import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
import onnxruntime as ort
from onnxruntime.tools.convert_onnx_models_to_ort import (
    OptimizationStyle,
    convert_onnx_models_to_ort,
    create_config_from_models,
)

HERE = Path(__file__).parent
MODELS = HERE / "models"
NAMES = ["tok", "pos", "dep"]
UNION_CONFIG = MODELS / "ort_ops.config"

# One entry per download variant the app offers. `suffix` is what
# `convert_onnx_models_to_ort` appends to the output name for the style, and the
# reason the variants cannot share a directory.
VARIANTS: dict[str, dict] = {
    "int8": {
        "dir": MODELS / "int8",
        "style": OptimizationStyle.Fixed,
        "suffix": "",
        "saved_opts": False,
        # bit-identical to the int8 `.onnx`
        "tolerance": 0.0,
    },
    "fp16": {
        "dir": MODELS / "fp16",
        "style": OptimizationStyle.Runtime,
        "suffix": ".with_runtime_opt",
        "saved_opts": True,
        # fp16 storage rounds the weights once, so replaying the optimizations
        # at load time reorders a few sums: 0.016 on dep's logits is the widest
        # gap measured on the verify corpus, and it flips one ambiguous edge.
        "tolerance": 0.05,
    },
}


def feeds_for(sess: ort.InferenceSession) -> dict[str, np.ndarray]:
    """One short input set, with the dep graph's root row convention.

    The dep graph adds a root row at index 0 whose span points at subword 0,
    while pos's first row points at subword 1 (tools/README.md). Building the
    dict by name also drops `token_span`/`mask` for the tok graph.
    """
    dep = any(x.name == "mask" for x in sess.get_inputs())
    feeds = {
        "input_ids": np.array([[101, 200, 102]], dtype=np.int64),
        "token_span": np.array([[[0], [1]]] if dep else [[[1]]], dtype=np.int64),
        "mask": np.ones((1, 2), dtype=np.bool_),
    }
    return {x.name: feeds[x.name] for x in sess.get_inputs()}


def session(path: Path, saved_opts: bool) -> ort.InferenceSession:
    options = ort.SessionOptions()
    if saved_opts:
        options.add_session_config_entry("session.enable_saved_runtime_optimizations", "1")
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def check(variant: str, name: str) -> None:
    """The `.ort` must compute what its `.onnx` computes — exactly for int8."""
    spec = VARIANTS[variant]
    onnx_path = spec["dir"] / f"biocn_{name}.onnx"
    ort_path = spec["dir"] / f"biocn_{name}.ort"
    if not ort_path.exists():
        sys.exit(f"missing {ort_path} — run without --check (or with --force)")
    ref = session(onnx_path, saved_opts=False)
    got = session(ort_path, saved_opts=spec["saved_opts"])
    if [(x.name, x.type) for x in ref.get_inputs()] != [
        (x.name, x.type) for x in got.get_inputs()
    ]:
        raise RuntimeError(f"{ort_path.name}: input signature changed")
    feeds = feeds_for(ref)
    widest = 0.0
    for a, b in zip(ref.run(None, feeds), got.run(None, feeds), strict=True):
        if a.shape != b.shape:
            raise RuntimeError(f"{ort_path.name}: output shape changed")
        widest = max(widest, float(np.abs(a.astype(np.float32) - b.astype(np.float32)).max()))
    if widest > spec["tolerance"]:
        raise RuntimeError(
            f"{ort_path.name}: output differs by {widest:.6f} (tolerance {spec['tolerance']})"
        )
    if spec["tolerance"] == 0.0:
        print(f"    identical to {onnx_path.name}")
    else:
        print(f"    within {widest:.6f} of {onnx_path.name}")


def stale(variant: str) -> bool:
    """True when a variant's `.ort` files are missing or older than their input."""
    for name in NAMES:
        onnx_path = VARIANTS[variant]["dir"] / f"biocn_{name}.onnx"
        ort_path = VARIANTS[variant]["dir"] / f"biocn_{name}.ort"
        if not ort_path.exists() or ort_path.stat().st_mtime < onnx_path.stat().st_mtime:
            return True
    return False


def convert(variant: str) -> None:
    spec = VARIANTS[variant]
    src = spec["dir"]
    # Convert into a scratch dir: given the model *directory*, the converter also
    # drops a `required_operators*.config` next to the models on every run, which
    # is a duplicate of what we generate below.
    with tempfile.TemporaryDirectory() as tmp:
        convert_onnx_models_to_ort(
            src,
            output_dir=Path(tmp),
            optimization_styles=[spec["style"]],
            save_optimized_onnx_model=False,
        )
        for name in NAMES:
            produced = Path(tmp) / f"biocn_{name}{spec['suffix']}.ort"
            if not produced.exists():
                sys.exit(f"converter produced no {produced.name}")
            shutil.move(str(produced), src / f"biocn_{name}.ort")
    print(f"wrote {variant} .ort files")


def main() -> None:
    if "--check" not in sys.argv:
        for variant, spec in VARIANTS.items():
            missing = [n for n in NAMES if not (spec["dir"] / f"biocn_{n}.onnx").exists()]
            if missing:
                sys.exit(
                    f"missing {variant}/{missing} — run `uv run python quantize_onnx.py` first"
                )
        for variant in VARIANTS:
            if stale(variant) or "--force" in sys.argv:
                convert(variant)
            else:
                print(f"{variant}: up to date (older than the .onnx inputs; --force to redo)")

        # Type reduction is what lets a minimal build drop the kernels for types
        # these graphs never produce (bool→float Cast variants, int64 MatMul, …).
        # Generated from the `.ort` files of every variant, so one `.so` serves
        # both downloads.
        create_config_from_models(
            [
                spec["dir"] / f"biocn_{n}.ort"
                for spec in VARIANTS.values()
                for n in NAMES
            ],
            UNION_CONFIG,
            enable_type_reduction=True,
        )
        print(f"wrote {UNION_CONFIG}")

    for variant in VARIANTS:
        for name in NAMES:
            print(f"  [{variant}/{name}]")
            check(variant, name)


if __name__ == "__main__":
    main()
