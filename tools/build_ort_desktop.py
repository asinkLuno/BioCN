#!/usr/bin/env python3
"""Build the minimal `libonnxruntime` BioCN ships on desktop and Android.

Every platform loads ORT at run time (`ort` crate's `load-dynamic`, see
`src-tauri/src/analysis/engine.rs`). The library is a *minimal build* driven by
the shared union op config (`tools/models/ort_ops.config`), which takes the full
34 MB / 15 MB of statically linked ExecutionProvider code down to a few MB.

Outputs:

    Linux   x86_64  -> src-tauri/ort/linux/libonnxruntime.so
    macOS   aarch64 -> src-tauri/ort/macos/libonnxruntime.dylib
    Windows x64     -> src-tauri/ort/windows/libonnxruntime.dll
    Android arm64   -> src-tauri/ort/android/arm64-v8a/libonnxruntime.so

The produced library must load BOTH shipped variants (int8 and fp16, both
converted in Runtime style with saved graph optimizations).

Usage:
    python3 -m tools.build_ort_desktop build --platform linux
    python3 -m tools.build_ort_desktop build --platform android
    python3 -m tools.build_ort_desktop build --platform macos --source /path/to/onnxruntime --python /path/to/venv-python
    python3 -m tools.build_ort_desktop verify <models-dir> <lib>

The desktop build drops its artifact at src-tauri/ort/<platform>/, which the
platform config (tauri.<os>.conf.json) bundles as res/libonnxruntime.<ext>.
The Android build drops its artifact at src-tauri/ort/android/arm64-v8a/, which
src-tauri/gen/android/app/build.gradle.kts includes via jniLibs.srcDir.

microsoft/onnxruntime vanished from GitHub entirely (404 for everyone since
2026-11, no rename/move; PyPI only ships wheels). The sources therefore come
from forks of the deleted repo: `ossia/onnxruntime` and `Krozark/onnxruntime`
still carry the pinned tag, their tag SHAs agree, so either is the genuine
tree. microsoft stays first in case it ever returns; `intel/onnxruntime` is
the historical mirror but its tags follow Intel's own v5.x line, so it only
ever served local `--source` builds.
"""

from __future__ import annotations

import argparse
import os
import platform as pyplatform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
CONFIG = HERE / "models" / "ort_ops.config"

ORT_VERSION = "1.31.1"
SOURCES = [
    f"https://github.com/ossia/onnxruntime/archive/refs/tags/v{ORT_VERSION}.zip",
    f"https://github.com/Krozark/onnxruntime/archive/refs/tags/v{ORT_VERSION}.zip",
    f"https://github.com/microsoft/onnxruntime/archive/refs/tags/v{ORT_VERSION}.zip",
]

# Flags shared by every platform. `--include_ops_by_config` + reduced type
# support is what makes the build "minimal": the kernels are filtered down to
# the union config BEFORE compilation, no ONNX parser, no exceptions, no RTTI.
COMMON_CMAKE = [
    "--config=MinSizeRel",
    "--build_shared_lib",
    "--cmake_generator=Ninja",
    "--minimal_build",
    f"--include_ops_by_config={CONFIG}",
    "--enable_reduced_operator_type_support",
    "--disable_rtti",
    "--disable_exceptions",
    # Apple clang treats an unused constexpr in the kleidiai halfgemm TU as an
    # error under -Werror (-Wunused-const-variable), which comes and goes with
    # the runner's Xcode version; the shipped library does not care.
    "--compile_no_warning_as_error",
    "--parallel=0",
]

def host_default() -> str:
    system = pyplatform.system()
    if system == "Linux":
        return "linux"
    if system == "Darwin":
        return "macos"
    if system == "Windows":
        return "windows"
    raise SystemExit(f"unsupported host: {system}")


def artifact_name(platform: str) -> str:
    return {
        "linux": "libonnxruntime.so",
        "macos": "libonnxruntime.dylib",
        "windows": "libonnxruntime.dll",
        "android": "libonnxruntime.so",
    }[platform]

def pick_python(explicit: str | None) -> str:
    """The interpreter that drives ORT's build.py.

    It must have `flatbuffers` installed: tools/python/util/__init__.py only
    exports `parse_config` (used to reduce the kernel set) when that import
    succeeds, and stays silent otherwise. Pass --python explicitly; the CLI
    wrapper (`uv run`) has the right venv activated already, or the pip
    .venv next to this script is used as a fallback.
    """
    if explicit:
        return explicit
    candidate = Path(__file__).parent / ".venv" / "bin" / "python"
    if candidate.exists():
        return str(candidate)
    return sys.executable or "python3"

def build(platform: str, out: Path | None, source: Path | None, python: str | None = None) -> Path:
    if not CONFIG.exists():
        raise SystemExit(f"missing {CONFIG}; run tools/convert_ort.py first")

    if out is None:
        # tauri.<os>.conf.json picks desktop artifacts from src-tauri/ort/<platform>/;
        # Android Gradle jniLibs picks arm64-v8a from src-tauri/ort/android/arm64-v8a/.
        if platform == "android":
            out = HERE.parent / "src-tauri" / "ort" / "android" / "arm64-v8a"
        else:
            out = HERE.parent / "src-tauri" / "ort" / platform

    work = source or Path(tempfile.mkdtemp(prefix="ort-build-"))
    src = work / f"onnxruntime-{ORT_VERSION}"
    if not src.exists():
        # --source may point at the checkout itself (or its parent).
        src = work if (work / "build.sh").exists() else src
    if not src.exists():
        print(f"fetching onnxruntime {ORT_VERSION} ...")
        for candidate in SOURCES:
            if extract(candidate, work):
                break
            print(f"  retrying with next source ...")
        else:
            raise SystemExit("could not download onnxruntime sources")
    print(f"using sources from {src}")

    build_dir = src / "build" / ("Android" if platform == "android" else "Desktop")
    build_dir.mkdir(parents=True, exist_ok=True)

    # ORT's build.sh invokes a bare `python3` for reduce_op_kernels (kernel
    # reduction), which needs flatbuffers via tools/python/util. Front-load the
    # chosen interpreter's bin dir so that `python3` resolves inside the venv.
    driver = pick_python(python)
    env = {**os.environ, "PATH": f"{Path(driver).parent}{os.pathsep}{os.environ.get('PATH', '')}"}
    if platform == "windows":
        args = ["cmd", "/c", str(src / "build.bat")]
    else:
        args = ["bash", str(src / "build.sh")]

    extra_args: list[str] = []
    if platform == "android":
        android_sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
        android_ndk = os.environ.get("ANDROID_NDK_HOME") or os.environ.get("NDK_HOME")
        if not android_sdk or not Path(android_sdk).exists():
            raise SystemExit("ANDROID_HOME (or ANDROID_SDK_ROOT) must point to an installed Android SDK")
        if not android_ndk or not Path(android_ndk).exists():
            raise SystemExit("ANDROID_NDK_HOME (or NDK_HOME) must point to an installed Android NDK")
        extra_args = [
            "--android",
            f"--android_sdk_path={android_sdk}",
            f"--android_ndk_path={android_ndk}",
            "--android_abi=arm64-v8a",
            "--android_api=24",
            "--skip_tests",
            "--cmake_extra_defines=ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON",
        ]

    result = subprocess.run(
        args
        + [
            f"--build_dir={build_dir}",
            # Keep FetchContent away from system-absl/protobuf/re2 packages (an
            # Arch box carries all three and re2's CMakeLists pulls system absl
            # in while ORT builds its own -> duplicate target errors).
            "--cmake_extra_defines=FETCHCONTENT_TRY_FIND_PACKAGE_MODE=NEVER",
            # ORT's CMake builds the gtest suite by default
            # (onnxruntime_BUILD_UNIT_TESTS defaults ON). Only the runtime
            # matters here, and Windows cannot even compile one of the tests
            # (env_test.cc / gsl::narrow), so exclude them on every platform.
            "--cmake_extra_defines=onnxruntime_BUILD_UNIT_TESTS=OFF",
            # Every dependency is a pinned FetchContent URL (cmake/deps.txt),
            # and the source tree is an archive checkout with no .git, so
            # submodule sync is neither possible nor needed.
            "--skip_submodule_sync",
        ]
        + extra_args
        + COMMON_CMAKE
        + ["--update", "--build"],
        cwd=src,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        raise SystemExit(f"build failed ({' '.join(args[:1])} ...), see output above")

    produced = find_artifact(build_dir, platform)
    out.mkdir(parents=True, exist_ok=True)
    target = out / artifact_name(platform)
    shutil.copy2(produced, target)
    print(f"built {target} ({target.stat().st_size / 1e6:.1f} MB)")
    return target


def extract(url: str, work: Path) -> bool:
    import time
    import urllib.error
    import urllib.request
    import zipfile

    archive = work / "ort.zip"
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as out:
                shutil.copyfileobj(response, out)
            break
        except urllib.error.HTTPError as error:
            print(f"  download failed ({url}): {error}")
            if error.code in (404, 410):
                return False
            if attempt == 3:
                return False
            time.sleep(2 * attempt)
        except OSError as error:
            print(f"  download failed ({url}, attempt {attempt}/3): {error}")
            if attempt == 3:
                return False
            time.sleep(2 * attempt)
    # zipfile instead of the unzip binary: Git Bash on the Windows runner has
    # no unzip, and sources need no exec bits (build.sh runs via `bash`).
    try:
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(work)
    except zipfile.BadZipFile as error:
        print(f"  corrupt archive ({url}): {error}")
        archive.unlink(missing_ok=True)
        return False
    archive.unlink()
    expected = work / f"onnxruntime-{ORT_VERSION}"
    if not expected.exists():
        # Archive roots are `{repo}-{ref}`; tolerate naming drift (a leading
        # `v` kept or stripped) by adopting the single extracted top-level dir.
        top = [p for p in work.iterdir() if p.is_dir() and (p / "build.sh").exists()]
        if len(top) == 1:
            top[0].rename(expected)
    return expected.exists()


def find_artifact(build_dir: Path, platform: str) -> Path:
    candidates = {
        "linux": ["libonnxruntime.so.*", "libonnxruntime.so"],
        "macos": ["libonnxruntime.*.dylib", "libonnxruntime.dylib"],
        "windows": ["onnxruntime.dll", "libonnxruntime.dll"],
        "android": ["libonnxruntime.so", "libonnxruntime.so.*"],
    }[platform]
    for pattern in candidates:
        hits = sorted(build_dir.rglob(pattern))
        # Prefer real files (not the trailing symlink chain .so -> .so.1 -> .so.1.33.0).
        for hit in hits:
            if hit.is_file() and not hit.is_symlink():
                return hit
    raise SystemExit(f"no {platform} artifact under {build_dir}")


def verify(models_dir: Path, library: Path) -> None:
    """Smoke the freshly built library with ctypes (GetApi + version).

    Real per-model verification is the Rust smoke run (tools/ortsmoke), which
    builds a Session for every shipped `.ort` — a missing kernel in this
    reduced build fails loudly exactly the way the app would hit it.
    """
    import ctypes

    api_version = 17  # ORT_API_VERSION of the pinned `ort` crate 2.0.0-rc.15
    lib = ctypes.CDLL(str(library), mode=ctypes.RTLD_GLOBAL)
    lib.OrtGetApiBase.restype = ctypes.c_void_p
    base = lib.OrtGetApiBase()
    if not base:
        raise SystemExit("OrtGetApiBase() returned NULL")
    get_api = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_uint)(
        ctypes.c_void_p.from_address(base).value)
    get_version = ctypes.CFUNCTYPE(ctypes.c_char_p)(
        ctypes.c_void_p.from_address(base + ctypes.sizeof(ctypes.c_void_p)).value)
    version = get_version().decode() if get_version() else "?"
    if not get_api(api_version):
        raise SystemExit(f"OrtGetApi({api_version}) returned NULL")
    print(f"verified {library} (ORT {version}, api {api_version} acquired)")

    missing = [p for variant in ("int8", "fp16")
               if not (p := models_dir / variant).exists()]
    if missing:
        raise SystemExit(f"models not found: {missing}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    build_cmd = sub.add_parser("build")
    build_cmd.add_argument("--platform", choices=("linux", "macos", "windows", "android"), default=host_default())
    build_cmd.add_argument("--out", type=Path, default=None,
                           help="output dir (default: src-tauri/ort/<platform>, or android/arm64-v8a)")
    build_cmd.add_argument("--source", type=Path, default=None, help="re-use an extracted onnxruntime tree")
    build_cmd.add_argument("--python", dest="python", default=None, help="interpreter that drives ORT's build.py (needs flatbuffers)")

    verify_cmd = sub.add_parser("verify")
    verify_cmd.add_argument("models", type=Path, help="tools/models with int8/ + fp16/ subdirs")
    verify_cmd.add_argument("library", type=Path)

    args = parser.parse_args()
    if args.command == "build":
        build(args.platform, args.out, args.source, args.python)
    else:
        verify(args.models, args.library)


if __name__ == "__main__":
    main()
