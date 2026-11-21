"""Stage the weights + aux tables and publish them to ModelScope.

The app does not embed the models any more: it downloads a *variant* on demand
and verifies every file against the sha256 in `manifest.json`. This script is
what produces that manifest — the shas are computed here, from the exact bytes
that get uploaded, so the app never has to trust a size alone.

Layout in the repo (one dir per download unit):

    manifest.json            variants, files, byte counts, sha256, ORT version
    tables/{vocab,normalize,…}   shared by every variant
    int8/biocn_{tok,pos,dep}.ort 省流 (~67 MB) — default
    fp16/biocn_{tok,pos,dep}.ort 高精度 (~78 MB)

The fp16 files are Runtime-style ORT models (`tools/convert_ort.py`): loading
them needs `session.enable_saved_runtime_optimizations=1`. Fixed-style fp16
would be 137 MB — ORT dequantizes the weights while optimizing — so that style
is not an option here.

ModelScope serves these through `?Revision=<sha>&FilePath=<path>`, which 302s to
a CDN that honours `Range`, so the app resumes interrupted downloads. Pinning a
commit sha (rather than `master`) is why the manifest is uploaded in the same
commit as the weights: the sha printed at the end of this script goes into
`REVISION` in `src-tauri/src/models.rs`.

The manifest itself is pinned by digest (`MANIFEST_SHA256` in the same file).
The revision sha in the URL only says *where* to ask; the weights are checked
against the digests inside the manifest, so the manifest is what the binary has
to trust. Both constants are printed at the end of this script — bump them
together, in the same commit.

Usage:
    uv run python publish_models.py --dry-run     # stage + print the manifest
    uv run python publish_models.py               # stage + upload
"""

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
MODELS = HERE / "models"
STAGING = HERE / ".cache" / "modelscope-staging"

REPO = "starmountain1997/biocn"
ORT_VERSION = "1.31.1"

NAMES = ["tok", "pos", "dep"]
TABLES = [
    "vocab.txt",
    "normalize.json",
    "tok_tags.json",
    "pos_tags.json",
    "dep_rel_labels.json",
]

# Labels are user-facing (the settings sheet shows them), so they live here next
# to the files they describe rather than in the app.
VARIANTS = {
    "int8": {
        "label": "省流",
        "description": "int8 动态量化，体积最小，少量歧义边会翻转",
        "dir": "int8",
    },
    "fp16": {
        "label": "高精度",
        "description": "fp16 权重，精度接近 fp32，下载稍大",
        "dir": "fp16",
    },
}


def digest(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest(), path.stat().st_size


def entry(rel: str) -> dict:
    sha, size = digest(STAGING / rel)
    return {"path": rel, "bytes": size, "sha256": sha}


def stage() -> dict:
    if STAGING.exists():
        shutil.rmtree(STAGING)
    STAGING.mkdir(parents=True)

    tables = []
    for name in TABLES:
        src = MODELS / name
        if not src.exists():
            sys.exit(f"missing {src}")
        shutil.copy2(src, STAGING / name)
        tables.append(entry(name))

    variants = {}
    for variant, spec in VARIANTS.items():
        for name in NAMES:
            src = MODELS / variant / f"biocn_{name}.ort"
            if not src.exists():
                sys.exit(f"missing {src} — run `uv run python convert_ort.py` first")
            (STAGING / variant).mkdir(exist_ok=True)
            shutil.copy2(src, STAGING / variant / src.name)
        files = [entry(f"{variant}/biocn_{n}.ort") for n in NAMES]
        variants[variant] = {
            "label": spec["label"],
            "description": spec["description"],
            "bytes": sum(f["bytes"] for f in files) + sum(t["bytes"] for t in tables),
            "files": files,
        }

    manifest = {
        "schema": 1,
        "ort": ORT_VERSION,
        "tables": tables,
        "variants": variants,
    }
    (STAGING / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )
    shutil.copy2(HERE / "LICENSE", STAGING / "LICENSE")
    (STAGING / "README.md").write_text(readme(manifest))
    return manifest


def readme(manifest: dict) -> str:
    rows = "\n".join(
        f"| `{variant}` | {spec['label']} | {spec['bytes'] / 1e6:.1f} MB | {spec['description']} |"
        for variant, spec in manifest["variants"].items()
    )
    return f"""---
license: apache-2.0
tasks:
- token-classification
- dependency-parsing
language:
- zh
---

# BioCN Reader 模型

[biocn-reader](https://github.com/asinkLuno/biocn-reader) 的中文句法分析权重：
粗分词（BMES）、CTB9 词性、CTB9 依存句法，供应用内的主谓宾标注使用。

| 变体 | 名称 | 下载 | 说明 |
| --- | --- | --- | --- |
{rows}

权重是 ORT 格式（`{manifest['ort']}`），不是 `.onnx`：应用随包发布的
`libonnxruntime.so` 是裁剪的 minimal build，没有 ONNX 解析器。`fp16` 变体是
Runtime 风格转换，加载时需要 `session.enable_saved_runtime_optimizations=1`。

`manifest.json` 是应用唯一读取的索引：文件名、字节数、sha256 都在里面，
应用按它逐文件下载并校验。

## 来源

由 HanLP 的三个 `chinese-electra-180g-small` 模型（`COARSE_ELECTRA_SMALL_ZH`、
`CTB9_POS_ELECTRA_SMALL`、`CTB9_DEP_ELECTRA_SMALL`）导出为 ONNX 后量化得到，
转换脚本与验证语料在应用的 `tools/` 目录。HanLP 以 Apache-2.0 发布。
"""


def manifest_digest() -> str:
    """sha256 of the staged manifest — the value `MANIFEST_SHA256` must carry.

    The app checks every weight against the digests *inside* the manifest, so
    the manifest is the root of trust: without pinning it, a swapped manifest
    would hand the app digests for bytes of its own choosing.
    """
    return hashlib.sha256((STAGING / "manifest.json").read_bytes()).hexdigest()


def main() -> None:
    manifest = stage()
    total = sum(spec["bytes"] for spec in manifest["variants"].values())
    print(f"staged {STAGING} ({total / 1e6:.1f} MB across {len(VARIANTS)} variants)")
    for variant, spec in manifest["variants"].items():
        print(f"  {variant}: {spec['bytes'] / 1e6:.1f} MB, {len(spec['files'])} files")
    if "--dry-run" in sys.argv:
        print((STAGING / "manifest.json").read_text())
        print(f"\nmanifest sha256: {manifest_digest()}")
        return

    subprocess.run(
        [
            "modelscope",
            "upload",
            REPO,
            str(STAGING),
            "",
            "--repo-type",
            "model",
            "--commit-message",
            f"models: int8 + fp16 ORT weights (ORT {ORT_VERSION})",
        ],
        check=True,
    )
    print(
        "\nuploaded. pin both constants in src-tauri/src/models.rs:\n"
        "  MODELS_REVISION = \"<sha of this commit>\"\n"
        f"  MANIFEST_SHA256 = \"{manifest_digest()}\"\n"
        f"  (list the commit with: modelscope info --repo-type model {REPO})\n"
        "Bump them in the same commit as the weights, or shipped apps keep\n"
        "downloading the old ones and refuse the new manifest."
    )


if __name__ == "__main__":
    main()
