"""Stage and publish the Source Han Serif SC font to ModelScope.

The app no longer embeds the 16 MB WOFF2 in every platform installer: it
downloads it on demand when the user selects 思源宋体 (or from Settings) and
verifies exact byte length + sha256 before committing it to app data.

Layout in the ModelScope repo (`starmountain1997/biocn`):

    fonts/SourceHanSerifSC-Regular.woff2
    fonts/OFL-1.1.txt

Because shipped apps pin `REVISION` in `src-tauri/src/models.rs` and
`FONT_REVISION` in `src-tauri/src/fonts.rs`, uploading under `fonts/` creates
a new commit without disturbing existing model releases or `manifest.json`.

Usage:
    python3 tools/publish_fonts.py --dry-run [path/to/fonts_dir]
    python3 tools/publish_fonts.py [path/to/fonts_dir]
"""

import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parent
STAGING = HERE / ".cache" / "modelscope-fonts-staging"

REPO = "starmountain1997/biocn"
FONT_FILE = "SourceHanSerifSC-Regular.woff2"
LICENSE_FILE = "OFL-1.1.txt"
REMOTE_DIR = "fonts"


def digest(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest(), path.stat().st_size


def find_source_dir(args: list[str]) -> Path:
    positional = [a for a in args if not a.startswith("-")]
    if positional:
        return Path(positional[0]).resolve()
    candidates = [
        HERE / "fonts",
        ROOT / "public" / "fonts",
    ]
    for candidate in candidates:
        if (candidate / FONT_FILE).is_file():
            return candidate
    sys.exit(
        f"missing {FONT_FILE} — pass the directory containing {FONT_FILE} and {LICENSE_FILE}"
    )


def stage(source_dir: Path) -> tuple[str, int]:
    font_src = source_dir / FONT_FILE
    license_src = source_dir / LICENSE_FILE
    for path in (font_src, license_src):
        if not path.is_file():
            sys.exit(f"missing {path}")
    header = font_src.read_bytes()[:4]
    if header != b"wOF2":
        sys.exit(f"{font_src} is not a valid WOFF2 file")

    if STAGING.exists():
        shutil.rmtree(STAGING)
    STAGING.mkdir(parents=True)
    shutil.copy2(font_src, STAGING / FONT_FILE)
    shutil.copy2(license_src, STAGING / LICENSE_FILE)
    return digest(STAGING / FONT_FILE)


def main() -> None:
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    source_dir = find_source_dir(args)
    sha, size = stage(source_dir)
    print(f"staged {STAGING} ({size / 1e6:.2f} MB)")
    print(f"  {REMOTE_DIR}/{FONT_FILE}")
    print(f"  bytes : {size}")
    print(f"  sha256: {sha}")
    if dry_run:
        return

    subprocess.run(
        [
            "modelscope",
            "upload",
            REPO,
            str(STAGING),
            REMOTE_DIR,
            "--repo-type",
            "model",
            "--commit-message",
            f"fonts: publish {FONT_FILE} (OFL-1.1)",
        ],
        check=True,
    )
    print(
        "\nuploaded. pin these constants in src-tauri/src/fonts.rs:\n"
        f'  const FONT_REVISION: &str = "<sha of this commit>";\n'
        f"  const FONT_BYTES: u64 = {size};\n"
        f'  const FONT_SHA256: &str = "{sha}";\n'
        f"  (list the commit with: modelscope info --repo-type model {REPO})"
    )


if __name__ == "__main__":
    main()
