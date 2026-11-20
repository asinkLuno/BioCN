# tools — model export and publishing

The app does not embed weights. It downloads one *variant* on demand and verifies
every file against the sha256 in the published `manifest.json`. These scripts are
what produces those artifacts; a normal app build needs none of them.

Ported from `https://github.com/asinkLuno/biocn-reader` (branch
`archive/epub-colorize`), which produced the same files for the mobile build.

## Why three ONNX graphs

bioCN runs three HanLP models per sentence: a tokenizer (`tok`), a part-of-speech
tagger (`pos`) and a dependency parser (`dep`). The parser's output is what the
coloring comes from — `nsubj`/`nobj`/`root` become 主 / 宾 / 谓. They are exported
separately because each has its own shape and its own input length limit; the
Rust side (`src-tauri/src/analysis/`) feeds one into the next.

## Why `.ort` and not `.onnx`

The shipped `libonnxruntime.so` in the mobile build was a *minimal* build: it
carries only the kernels in an operator config and no ONNX parser at all. A
minimal build can therefore only load ORT-format models, so `convert_ort.py` does
the conversion on the desktop and the app downloads `.ort` files directly.

The desktop app ships the same minimal `libonnxruntime` as Android (below), so
only `.ort` is published there too: `.onnx` stays a local intermediate and is
gitignored.

`build_ort_desktop.py` compiles the per-platform minimal library in CI from the
shared `ort_ops.config`; `tauri.<os>.conf.json` bundles the artifact as
`res/libonnxruntime.<ext>` and the engine resolves it through `ORT_DYLIB_PATH`
(`src-tauri/src/lib.rs`). The 15 MB of statically linked ExecutionProvider code
that `download-binaries` used to link into every desktop binary is gone.

## Order

```sh
uv sync

uv run python export_onnx.py       # HanLP -> models/*.onnx        (needs HF download)
uv run python quantize_onnx.py     # -> models/int8/*.onnx, models/fp16/*.onnx
uv run python convert_ort.py       # -> models/{int8,fp16}/*.ort + ort_ops.config
uv run python verify_onnx.py       # numeric parity: torch vs onnx vs quantized
uv run python publish_models.py    # --dry-run stages + prints the manifest;
                                   # without it, uploads to ModelScope
```

`ref/biocn_analyzer.py` is the upstream analyzer kept as the reference
implementation: `verify_onnx.py` compares against it, and the Rust pipeline
(`src-tauri/src/analysis/`) was ported from it line by line.

## The two variants

Both are the same three graphs, differing only in how the weights are stored:

| variant | size | note |
| --- | --- | --- |
| `int8` | ~67 MB | dynamic-int8 weights; the default |
| `fp16` | ~78 MB | higher precision, and needs `session.enable_saved_runtime_optimizations=1` |

The fp16 files are `OptimizationStyle.Runtime`: ORT keeps the weights in fp16 and
defers optimization to load time. With `Fixed` style instead, ORT dequantizes
them back to fp32 while optimizing and the file grows to 137 MB — twice the int8
variant. That is the one flag in `convert_ort.py` that must not be "fixed".

## Published layout

```
manifest.json                  schema, ORT version, tables, variants
vocab.txt, normalize.json,     shared by every variant
tok_tags.json, pos_tags.json,
dep_rel_labels.json
int8/biocn_{tok,pos,dep}.ort
fp16/biocn_{tok,pos,dep}.ort
```

ModelScope serves these through `?Revision=<sha>&FilePath=<path>`, which redirects
to a CDN that honours `Range`, so the app resumes interrupted downloads. Pinning a
commit sha rather than `master` is why the manifest is uploaded in the same commit
as the weights: the sha printed by `publish_models.py` is what
`src-tauri/src/models.rs` (`REVISION`) points at. Bumping the weights means
bumping that constant, or shipped apps keep downloading the old ones.

`MANIFEST_SHA256` in the same file pins the manifest's own bytes. Every weight
is verified against the digests inside the manifest, so the manifest is the root
of trust — a revision sha only says where the app asks, not what it gets. Both
constants are printed by `publish_models.py` when it finishes; bump them
together.
