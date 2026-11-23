//! On-demand Source Han Serif SC font: download from ModelScope, verify, serve,
//! and remove.
//!
//! Instead of bundling the 16 MB WOFF2 into every platform installer, BioCN
//! downloads it once when the user selects 思源宋体 (or from Settings) and stores
//! it under `<app_data_dir>/fonts/SourceHanSerifSC-Regular.woff2`.
//!
//! The single asset is pinned directly by ModelScope commit `FONT_REVISION`,
//! exact byte length `FONT_BYTES`, and `FONT_SHA256` (`tools/publish_fonts.py`),
//! so the app knows the exact download size offline and verifies every byte
//! before making the font visible to `book://`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::models::{download, modelscope_url, part_path, sha256};
use crate::net::{CANCELLED_ERR, CancelSlot};

/// Filename stored under `<app_data_dir>/fonts/`.
pub const SERIF_FONT_FILE: &str = "SourceHanSerifSC-Regular.woff2";

/// Path inside the ModelScope repo (`starmountain1997/biocn`).
const REMOTE_PATH: &str = "fonts/SourceHanSerifSC-Regular.woff2";

/// Commit sha on ModelScope (`tools/publish_fonts.py`).
const FONT_REVISION: &str = "c85566bf69a8cda288541eda64c268ebb7e0e611";

/// Exact byte length of `SourceHanSerifSC-Regular.woff2` at [`FONT_REVISION`].
const FONT_BYTES: u64 = 16_708_168;

/// Exact sha256 of `SourceHanSerifSC-Regular.woff2` at [`FONT_REVISION`].
const FONT_SHA256: &str = "662226f79a8aee4b8ef05b175b9c4d967c5a17e9efad51387d0dea84ac6f0aed";

/// Event emitted while downloading the serif font.
pub const FONT_PROGRESS_EVENT: &str = "fonts://progress";

type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Serializes install/remove writes to `<app_data_dir>/fonts/` so concurrent
/// callers (e.g. double-clicking 思源宋体) share one writer without clobbering
/// the `.part` file.
fn op_lock() -> &'static tauri::async_runtime::Mutex<()> {
    static LOCK: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tauri::async_runtime::Mutex::new(()))
}

fn cancel_slot() -> &'static CancelSlot {
    static SLOT: OnceLock<CancelSlot> = OnceLock::new();
    SLOT.get_or_init(CancelSlot::default)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FontStatus {
    pub installed: bool,
    /// Published download size in bytes (always known offline).
    pub bytes: u64,
    /// Bytes installed on disk; 0 when not installed.
    pub size: u64,
    /// Bytes already downloaded in `.part` from an interrupted attempt.
    pub partial: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontProgress {
    pub done: u64,
    pub total: u64,
}

fn fonts_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("fonts"))
}

fn font_path_in(dir: &Path) -> PathBuf {
    dir.join(SERIF_FONT_FILE)
}

fn font_url() -> String {
    modelscope_url(FONT_REVISION, REMOTE_PATH)
}

/// Returns true when `path` is a regular file with the expected byte length.
fn is_installed_file(path: &Path, expected_bytes: u64) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() == expected_bytes)
}

fn status_in(dir: &Path, expected_bytes: u64) -> FontStatus {
    let dest = font_path_in(dir);
    if is_installed_file(&dest, expected_bytes) {
        return FontStatus {
            installed: true,
            bytes: expected_bytes,
            size: expected_bytes,
            partial: 0,
        };
    }
    let part = part_path(&dest);
    let partial = std::fs::metadata(&part)
        .ok()
        .filter(|meta| meta.is_file() && meta.len() < expected_bytes)
        .map(|meta| meta.len())
        .unwrap_or(0);
    FontStatus {
        installed: false,
        bytes: expected_bytes,
        size: 0,
        partial,
    }
}

/// Verifies `part` against expected byte length and sha256, then atomically
/// promotes it to `dest`. On mismatch, removes `part` so the next try starts clean.
fn verify_and_commit(dest: &Path, expected_bytes: u64, expected_sha: &str) -> Result<()> {
    let part = part_path(dest);
    let len = std::fs::metadata(&part).map_err(err)?.len();
    if len != expected_bytes {
        let _ = std::fs::remove_file(&part);
        return Err(format!("思源宋体大小不符（{len} ≠ {expected_bytes}）"));
    }
    let got = sha256(&part)?;
    if got != expected_sha {
        let _ = std::fs::remove_file(&part);
        return Err("思源宋体校验失败，已丢弃".to_string());
    }
    // Windows refuses `rename` over an existing file, so unlink any stale dest first.
    if dest.exists() {
        let _ = std::fs::remove_file(dest);
    }
    std::fs::rename(&part, dest).map_err(err)
}

fn file_matches(path: &Path, expected_bytes: u64, expected_sha: &str) -> bool {
    is_installed_file(path, expected_bytes)
        && sha256(path).is_ok_and(|got| got == expected_sha)
}

fn remove_in(dir: &Path) -> Result<()> {
    let dest = font_path_in(dir);
    let part = part_path(&dest);
    for path in [&dest, &part] {
        if path.exists() {
            std::fs::remove_file(path).map_err(err)?;
        }
    }
    Ok(())
}

/// Reads the installed Source Han Serif SC WOFF2 bytes for `book://`, or `None`
/// if the font has not been downloaded yet.
pub fn read_installed_serif_font<R: Runtime>(app: &AppHandle<R>) -> Option<Vec<u8>> {
    let dir = fonts_dir(app).ok()?;
    let path = font_path_in(&dir);
    if !is_installed_file(&path, FONT_BYTES) {
        return None;
    }
    std::fs::read(path).ok()
}

#[tauri::command]
pub async fn font_status<R: Runtime>(app: AppHandle<R>) -> Result<FontStatus> {
    let dir = fonts_dir(&app)?;
    Ok(status_in(&dir, FONT_BYTES))
}

/// Cancels an in-flight serif font download promptly while keeping `.part` for
/// Range resume on the next attempt.
#[tauri::command]
pub async fn font_cancel() -> bool {
    cancel_slot().cancel()
}

/// Downloads (with Range resume), verifies, and installs Source Han Serif SC.
/// Idempotent: if already verified on disk, returns immediately without network I/O.
#[tauri::command]
pub async fn font_install<R: Runtime>(app: AppHandle<R>) -> Result<FontStatus> {
    let _guard = op_lock().lock().await;
    let cancel_guard = cancel_slot().begin();
    let cancel = cancel_guard.token();
    let dir = fonts_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    let dest = font_path_in(&dir);

    let already_ok = {
        let dest = dest.clone();
        tauri::async_runtime::spawn_blocking(move || {
            file_matches(&dest, FONT_BYTES, FONT_SHA256)
        })
        .await
        .unwrap_or(false)
    };
    if already_ok {
        let _ = std::fs::remove_file(part_path(&dest));
        return Ok(status_in(&dir, FONT_BYTES));
    }

    // If a previous crash finished writing `.part` right before rename, promote it directly.
    let part = part_path(&dest);
    let promoted = if std::fs::metadata(&part).is_ok_and(|m| m.len() == FONT_BYTES) {
        let dest = dest.clone();
        tauri::async_runtime::spawn_blocking(move || {
            verify_and_commit(&dest, FONT_BYTES, FONT_SHA256).is_ok()
        })
        .await
        .unwrap_or(false)
    } else {
        false
    };
    if promoted {
        return Ok(status_in(&dir, FONT_BYTES));
    }

    let client = crate::net::model_client()?;
    let url = font_url();
    download(client, &url, &dest, FONT_BYTES, cancel, |done| {
        let _ = app.emit(
            FONT_PROGRESS_EVENT,
            FontProgress {
                done,
                total: FONT_BYTES,
            },
        );
    })
    .await?;

    if cancel.is_cancelled() {
        return Err(CANCELLED_ERR.to_string());
    }

    {
        let dest = dest.clone();
        tauri::async_runtime::spawn_blocking(move || {
            verify_and_commit(&dest, FONT_BYTES, FONT_SHA256)
        })
        .await
        .map_err(err)??;
    }
    Ok(status_in(&dir, FONT_BYTES))
}

/// Removes the downloaded serif font and any partial download file. Idempotent.
#[tauri::command]
pub async fn font_remove<R: Runtime>(app: AppHandle<R>) -> Result<FontStatus> {
    let _guard = op_lock().lock().await;
    let dir = fonts_dir(&app)?;
    remove_in(&dir)?;
    Ok(status_in(&dir, FONT_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("biocn-font-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp font dir");
        dir
    }

    fn sha_of(bytes: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(bytes);
        format!("{:x}", h.finalize())
    }

    #[test]
    fn status_reports_missing_partial_and_installed_states() {
        let dir = test_dir("status");
        let expected = 12u64;

        // Missing
        assert_eq!(
            status_in(&dir, expected),
            FontStatus {
                installed: false,
                bytes: expected,
                size: 0,
                partial: 0,
            }
        );

        // Partial download
        let dest = font_path_in(&dir);
        std::fs::write(part_path(&dest), b"wOF2").expect("write part");
        assert_eq!(
            status_in(&dir, expected),
            FontStatus {
                installed: false,
                bytes: expected,
                size: 0,
                partial: 4,
            }
        );

        // Installed
        std::fs::write(&dest, b"wOF212345678").expect("write font");
        assert_eq!(
            status_in(&dir, expected),
            FontStatus {
                installed: true,
                bytes: expected,
                size: expected,
                partial: 0,
            }
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_and_commit_promotes_valid_part_and_rejects_bad_size_or_digest() {
        let dir = test_dir("verify");
        let dest = font_path_in(&dir);
        let payload = b"wOF2-valid-font-payload";
        let digest = sha_of(payload);

        // Bad length is rejected and deletes `.part`.
        std::fs::write(part_path(&dest), b"short").expect("write short");
        let err = verify_and_commit(&dest, payload.len() as u64, &digest).expect_err("bad size");
        assert!(err.contains("大小不符"), "{err}");
        assert!(!part_path(&dest).exists());
        assert!(!dest.exists());

        // Bad digest is rejected and deletes `.part`.
        std::fs::write(part_path(&dest), vec![0u8; payload.len()]).expect("write corrupt");
        let err =
            verify_and_commit(&dest, payload.len() as u64, &digest).expect_err("bad sha256");
        assert!(err.contains("校验失败"), "{err}");
        assert!(!part_path(&dest).exists());
        assert!(!dest.exists());

        // Valid payload commits atomically and removes `.part`.
        std::fs::write(part_path(&dest), payload).expect("write valid");
        verify_and_commit(&dest, payload.len() as u64, &digest).expect("commit");
        assert!(!part_path(&dest).exists());
        assert_eq!(std::fs::read(&dest).expect("read dest"), payload);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_clears_installed_and_partial_files_idempotently() {
        let dir = test_dir("remove");
        let dest = font_path_in(&dir);
        std::fs::write(&dest, b"font").expect("write dest");
        std::fs::write(part_path(&dest), b"part").expect("write part");

        remove_in(&dir).expect("first remove");
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());

        // Second remove succeeds without error.
        remove_in(&dir).expect("second remove");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pinned_font_url_targets_modelscope_revision() {
        let url = font_url();
        assert!(url.contains("starmountain1997/biocn"), "{url}");
        assert!(url.contains(FONT_REVISION), "{url}");
        assert!(url.ends_with("FilePath=fonts/SourceHanSerifSC-Regular.woff2"), "{url}");
        assert_eq!(FONT_SHA256.len(), 64);
    }
}
