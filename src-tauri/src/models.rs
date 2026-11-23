//! Model weights: download, verify, install, switch — and nothing else.
//!
//! The weights are not in the installer. The reader picks a variant in settings,
//! this module downloads it once from ModelScope, and the analyzer loads it from
//! app data.
//!
//! Where the truth lives: ModelScope, pinned by `REVISION`. `manifest.json` in
//! the repo lists each variant's files with byte counts and sha256; this module
//! reads that manifest and verifies every byte it writes. Nothing is derived
//! from a URL path — renaming a weight upstream changes the manifest, not us.
//!
//! The weights are ORT-format (`.ort`), not `.onnx`: that is what upstream
//! publishes, and the full ONNX Runtime build we link on desktop loads both
//! formats by sniffing the magic bytes (`InferenceSession::Load` →
//! `IsOrtFormatModel`), so one set of weights serves every platform.
//!
//! Interrupted downloads resume: ModelScope's CDN honours `Range`, so a `.part`
//! file continues where it stopped instead of restarting 21 MB. Files are only
//! renamed into place after their sha256 matches, so a half-written weight can
//! never be loaded.
//!
//! Both variants can be installed at once; `settings.json` records which one is
//! active and the analyzer loads that one. Installation is per variant (own
//! directory, own stamp), so switching is instant — a few seconds of session
//! load, never a download.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::analyzer::AnalyzerState;

/// Repository on ModelScope (upstream's `tools/publish_models.py` uploads it).
pub(crate) const REPO: &str = "starmountain1997/biocn";
/// Commit sha, not `master`: weights must not change under a released app.
const REVISION: &str = "a226e0cfeee17a29ce8a2225717626dc2db0ac9c";

/// sha256 of `manifest.json` at [`REVISION`].
///
/// Every weight is verified against the digests *inside* the manifest, so the
/// manifest is the root of trust and has to be pinned here; `REVISION` in the
/// URL only says where to ask. Bump both together (`tools/README.md`).
const MANIFEST_SHA256: &str = "c668f5e8ee2567ba5e23226aee9fd062b13b946fc9ec1d8ea555ec10ef0dbe2c";

/// Where a debug build reads weights from instead of the network: the same
/// directory `tools/convert_ort.py` writes, so `tauri dev` works offline.
const LOCAL_SOURCE: &str = "../tools/models";

/// Progress events are one per chunk batch, not one per chunk: a 21 MB file at
/// 8 KB per chunk would otherwise be 2600 webview round trips.
const PROGRESS_STEP: u64 = 512 * 1024;

type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct File {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Variant {
    label: String,
    description: String,
    bytes: u64,
    files: Vec<File>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    /// `1` for the layout below; a bump means the app must not read it.
    schema: u32,
    tables: Vec<File>,
    variants: BTreeMap<String, Variant>,
}

impl Manifest {
    /// The files a variant needs, tables included (they are shared by variants
    /// but installed per variant, because only one variant lives on disk).
    fn files(&self, variant: &str) -> Result<(&Variant, Vec<&File>)> {
        let spec = self
            .variants
            .get(variant)
            .ok_or_else(|| format!("未知的模型版本 {variant}"))?;
        let mut files: Vec<&File> = self.tables.iter().collect();
        files.extend(spec.files.iter());
        Ok((spec, files))
    }
}

/// What the settings page shows.
///
/// `installed` lists every variant whose weights are on disk; `active` is the
/// one the analyzer loads and the user has picked. They are separate because a
/// variant being on disk says nothing about which one is in use.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: Vec<String>,
    pub active: Option<String>,
    pub variants: Vec<VariantStatus>,
    /// Why the published sizes are missing. `None` when the manifest loaded;
    /// the page turns it into "连不上服务器" instead of a dead button.
    pub manifest_error: Option<String>,
    /// Something the user should know that is not an error (weights that could
    /// not be deleted because the OS still has them mapped). `None` normally.
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariantStatus {
    pub id: String,
    pub label: String,
    pub description: String,
    /// Download size as published; 0 when the manifest could not be read.
    pub bytes: u64,
    /// Bytes of this variant actually on disk, 0 when it is not installed.
    pub size: u64,
    /// Bytes already downloaded from an interrupted attempt at this variant.
    pub partial: u64,
}

/// Root of the model store: `<app data>/models/`.
fn root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("models"))
}

/// Directory of the variant the reader should load, or the error the analyzer
/// turns into "download a model in settings".
///
/// Nothing installed falls back to the first variant alphabetically — the
/// choice has to default somewhere, and `int8` is the cheaper one.
pub fn installed_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let root = root(app)?;
    let active = crate::settings::active_variant(app)
        .filter(|variant| installed(&root.join(variant)).is_some())
        .or_else(|| {
            let installed: Vec<String> = VARIANTS
                .into_iter()
                .filter(|variant| installed(&root.join(variant)).is_some())
                .map(str::to_owned)
                .collect();
            // VARIANTS is in the order the fallback must try, no sort needed.
            installed.into_iter().next()
        });
    let variant =
        active.ok_or_else(|| "models-missing: 尚未下载模型（设置 → 分析模型）".to_string())?;
    Ok(root.join(variant))
}

/// The weights every variant must have. The stamp is checked against these,
/// not just against itself: a truncated or half-written stamp would otherwise
/// list a single file and `installed()` would call the variant complete.
const REQUIRED: [&str; 3] = ["biocn_tok.ort", "biocn_pos.ort", "biocn_dep.ort"];

/// Event the install download streams [`Progress`] on. The frontend
/// (`src/lib/models.ts`) listens on the same literal.
pub const MODELS_PROGRESS_EVENT: &str = "models://progress";

/// The variant whose files all sit in `dir`, per the stamp it wrote.
///
/// The stamp lists names and lengths rather than a bare variant name: app data
/// is the place the OS and the reader can both delete from, and "the stamp
/// exists" would then pass while `biocn_tok.ort` is gone.
fn installed(dir: &Path) -> Option<String> {
    let stamp = std::fs::read_to_string(dir.join("stamp")).ok()?;
    let variant = stamp.lines().next()?.to_string();
    if !is_variant(&variant) {
        return None;
    }
    let mut seen: Vec<&str> = Vec::new();
    for line in stamp.lines().skip(1) {
        let (name, len) = line.rsplit_once(' ')?;
        let len: u64 = len.parse().ok()?;
        match std::fs::metadata(dir.join(name)) {
            Ok(meta) if meta.len() == len => seen.push(name),
            _ => return None,
        }
    }
    // Every required weight has to be in the list, not merely on disk: a stamp
    // cut short by a crash would otherwise describe a partial install.
    if !REQUIRED.iter().all(|name| seen.contains(name)) {
        return None;
    }
    Some(variant)
}

/// The two published weight sets, in display order (int8 first: it is the
/// cheaper one and the alphabetical fallback in `installed_dir` relies on
/// the sorted order).
const VARIANTS: [&str; 2] = ["int8", "fp16"];

fn is_variant(name: &str) -> bool {
    VARIANTS.contains(&name)
}

/// Total size of the regular files directly inside `dir`; 0 if it is missing.
fn dir_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.metadata().ok())
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .sum()
}

/// The HTTP client every ModelScope call shares.
fn client() -> Result<&'static reqwest::Client> {
    crate::net::model_client()
}

/// Verified immutable manifest cached for the lifetime of the process: because
/// `MANIFEST_SHA256` is pinned in the binary, once verified it never changes.
static CACHED_MANIFEST: std::sync::OnceLock<Manifest> = std::sync::OnceLock::new();

fn cached_manifest() -> Result<Manifest> {
    CACHED_MANIFEST
        .get()
        .cloned()
        .ok_or_else(|| "模型清单尚未加载".to_string())
}

async fn fetch_manifest() -> Result<Manifest> {
    if let Some(manifest) = CACHED_MANIFEST.get() {
        return Ok(manifest.clone());
    }
    let body = client()?
        .get(file_url("manifest.json"))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("模型清单：{e}"))?
        .error_for_status()
        .map_err(|e| format!("模型清单：{e}"))?
        .text()
        .await
        .map_err(|e| format!("模型清单：{e}"))?;
    let manifest = parse_manifest(&body)?;
    let _ = CACHED_MANIFEST.set(manifest.clone());
    Ok(manifest)
}

/// A manifest this app will act on.
///
/// The digest pins what ModelScope must serve: every weight is checked against
/// the sha256 in *this* manifest, so a manifest swapped upstream (or served by
/// something other than ModelScope) would otherwise hand us digests for bytes
/// it chose. Verifying a single file is what makes that chain trustworthy, and
/// it is the one file whose digest has to live in the binary.
fn parse_manifest(body: &str) -> Result<Manifest> {
    let digest = sha256_bytes(body.as_bytes());
    if digest != MANIFEST_SHA256 {
        return Err(format!(
            "manifest: 校验失败（{digest}），服务器上的模型清单被改动过"
        ));
    }
    let manifest: Manifest = serde_json::from_str(body).map_err(|e| format!("模型清单：{e}"))?;
    if manifest.schema != 1 {
        return Err(format!(
            "模型清单的 schema 为 {}，本应用只支持 schema 1，请更新应用",
            manifest.schema
        ));
    }
    Ok(manifest)
}

pub(crate) fn modelscope_url(revision: &str, path: &str) -> String {
    format!("https://modelscope.cn/api/v1/models/{REPO}/repo?Revision={revision}&FilePath={path}")
}

fn file_url(path: &str) -> String {
    modelscope_url(REVISION, path)
}

/// A manifest path is only ever used as `<variant>/<basename>`: no separators
/// from the server reach the filesystem, so a hostile manifest cannot write
/// outside the model dir.
fn basename(path: &str) -> Result<&str> {
    if path
        .split('/')
        .any(|segment| segment.is_empty() || segment.starts_with('.'))
    {
        return Err(format!("路径无效 {path}"));
    }
    let name = path
        .rsplit('/')
        .next()
        .ok_or_else(|| format!("路径无效 {path}"))?;
    if name.contains('\\') {
        return Err(format!("路径无效 {path}"));
    }
    Ok(name)
}

#[derive(Debug, Clone, Serialize)]
struct Progress {
    variant: String,
    file: String,
    done: u64,
    total: u64,
}

/// Stream `url` into `dest`, resuming from an existing `dest.part`.
///
/// `Range` is what makes a 21 MB download survive a dropped connection; a
/// server that ignores it answers 200 and the part file is truncated rather than
/// appended, so the two cases cannot interleave into a corrupt file.
pub(crate) async fn download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    len: u64,
    mut progress: impl FnMut(u64),
) -> Result<()> {
    let part = part_path(dest);
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    // A part file longer than the target cannot be a prefix of it (the manifest
    // changed, or the transfer restarted from a different revision), and asking
    // for `bytes=<too big>-` earns a 416 that never clears on its own.
    if have >= len {
        let _ = std::fs::remove_file(&part);
        have = 0;
    }
    let mut request = client.get(url);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut response = request
        .send()
        .await
        .map_err(|e| format!("{url}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("{url}: {e}"))?;
    let expected_range_prefix = format!("bytes {have}-");
    let content_range_ok = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with(&expected_range_prefix));
    let resumed =
        response.status() == reqwest::StatusCode::PARTIAL_CONTENT && have > 0 && content_range_ok;
    let mut file = if resumed {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .map_err(err)?
    } else {
        std::fs::File::create(&part).map_err(err)?
    };

    let mut written = if resumed { have } else { 0 };
    let mut reported = written;
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("{url}: {e}"))? {
        std::io::Write::write_all(&mut file, &chunk).map_err(err)?;
        written += chunk.len() as u64;
        if written - reported >= PROGRESS_STEP {
            reported = written;
            progress(written);
        }
    }
    std::io::Write::flush(&mut file).map_err(err)?;
    progress(written);
    Ok(())
}

pub(crate) fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.push_str(".part");
    dest.with_file_name(name)
}

pub(crate) fn sha256(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(err)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buf).map_err(err)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Move `part` into place only when it matches the manifest byte-for-byte.
fn verify(dest: &Path, file: &File) -> Result<()> {
    let part = part_path(dest);
    let len = std::fs::metadata(&part).map_err(err)?.len();
    if len != file.bytes {
        let _ = std::fs::remove_file(&part);
        return Err(format!("{}: 大小不符（{len} ≠ {}）", file.path, file.bytes));
    }
    let got = sha256(&part)?;
    if got != file.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(format!("{}: 校验失败，已丢弃", file.path));
    }
    std::fs::rename(&part, dest).map_err(err)
}

/// Install `variant` from the local `tools/models` tree (debug builds only).
///
/// This is the developer shortcut: it copies whatever `tools/models` currently
/// holds, with no manifest and therefore no sha256 to check against. Release
/// builds never take this path (`cfg!(debug_assertions)` is false there).
fn install_local(staging: &Path, variant: &str) -> Result<Vec<(String, u64)>> {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(LOCAL_SOURCE);
    let tables = source.clone();
    let weights = source.join(variant);
    if !weights.is_dir() {
        return Err(format!(
            "本地没有 {variant} 权重（{}），请联网下载",
            weights.display()
        ));
    }
    let dir = staging.to_path_buf();
    std::fs::create_dir_all(&dir).map_err(err)?;

    let mut written = Vec::new();
    let names = [
        "vocab.txt",
        "normalize.json",
        "tok_tags.json",
        "pos_tags.json",
        "dep_rel_labels.json",
    ];
    let mut copies: Vec<(PathBuf, String)> = names
        .iter()
        .map(|name| (tables.join(name), (*name).to_string()))
        .collect();
    copies.extend(
        ["biocn_tok.ort", "biocn_pos.ort", "biocn_dep.ort"]
            .iter()
            .map(|name| (weights.join(name), (*name).to_string())),
    );
    for (from, name) in copies {
        let bytes = std::fs::copy(&from, dir.join(&name))
            .map_err(|e| format!("{}: {e}", from.display()))?;
        written.push((name, bytes));
    }
    Ok(written)
}

/// Sweep the leftovers a failed swap can leave in `dir`: the `.new`/`.old`
/// trees a rename died between, and any `.part` file of an interrupted move.
/// They hold real bytes, so leaving them would sit on disk forever.
fn sweep_swap_leftovers(dir: &Path) {
    for fragment in [".new", ".old"] {
        let _ = std::fs::remove_dir_all(with_suffix(dir, fragment));
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        if entry.file_name().to_string_lossy().ends_with(".part") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// `models/int8` + ".old" → `models/int8.old`.
fn with_suffix(dir: &Path, suffix: &str) -> PathBuf {
    let mut name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.push_str(suffix);
    dir.with_file_name(name)
}

/// Write the stamp, atomically.
///
/// A stamp is only written for a directory whose files are already in place, and
/// a torn write would leave `installed()` reading a prefix of the real list —
/// hence temp file plus rename.
fn write_stamp(dir: &Path, variant: &str, files: &[(String, u64)]) -> Result<()> {
    use std::io::Write as _;

    let mut text = variant.to_string();
    for (name, len) in files {
        text.push_str(&format!("\n{name} {len}"));
    }
    let temp = dir.join(format!("stamp.{}.tmp", std::process::id()));
    let write_res = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = std::fs::remove_file(&temp);
        return Err(err(e));
    }
    std::fs::rename(&temp, dir.join("stamp")).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        err(e)
    })
}

#[tauri::command]
pub async fn models_status<R: Runtime>(app: AppHandle<R>) -> Result<Status> {
    let root = root(&app)?;
    Ok(status_of(&app, &root, fetch_manifest().await))
}

/// The status of `root`, given whatever the manifest fetch produced.
///
/// Takes the fetch result rather than fetching itself because the callers
/// differ in what a network failure means: on the settings page it is just
/// "sizes unknown", but after a successful install it must not be reported as
/// a failure of the install — the weights are on disk either way.
fn status_of<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
    manifest: std::result::Result<Manifest, String>,
) -> Status {
    let active = crate::settings::active_variant(app)
        .filter(|variant| installed(&root.join(variant)).is_some());
    let (manifest, manifest_error) = match manifest {
        Ok(manifest) => (Some(manifest), None),
        Err(error) => (None, Some(error)),
    };
    let mut installed_variants = Vec::new();
    let variants = VARIANTS
        .into_iter()
        .map(|id| {
            let spec = manifest.as_ref().and_then(|m| m.variants.get(id));
            // A stamped directory counts as installed even if Windows keeps a
            // deleted file mapped: the stamp is the truth the reader goes by.
            let size = if installed(&root.join(id)).is_some() {
                installed_variants.push(id.to_owned());
                dir_bytes(&root.join(id))
            } else {
                0
            };
            VariantStatus {
                id: id.to_string(),
                label: spec.map(|s| s.label.clone()).unwrap_or_default(),
                description: spec.map(|s| s.description.clone()).unwrap_or_default(),
                bytes: spec.map(|s| s.bytes).unwrap_or_default(),
                size,
                // The resume point of an interrupted download; downloads land
                // in staging/<variant>.
                partial: if size == 0 {
                    dir_bytes(&root.join("staging").join(id))
                } else {
                    0
                },
            }
        })
        .collect();
    Status {
        installed: installed_variants,
        active,
        variants,
        manifest_error,
        warning: None,
    }
}

/// Download + verify + install `variant`, alongside whatever else is installed.
#[tauri::command]
pub async fn models_install<R: Runtime>(app: AppHandle<R>, variant: String) -> Result<Status> {
    if !is_variant(&variant) {
        return Err(format!("未知的模型版本 {variant}"));
    }
    // Held for the whole install, not just the swap: the download writes
    // `staging/<variant>` and the swap deletes it, so two installs of the same
    // variant would unlink the `.part` file the other is still appending to,
    // and the resume would start over.
    match app.try_state::<AnalyzerState>() {
        Some(state) => {
            state
                .while_installing_model(install(app.clone(), variant))
                .await
        }
        None => install(app, variant).await,
    }
}

async fn install<R: Runtime>(app: AppHandle<R>, variant: String) -> Result<Status> {
    let root = root(&app)?;
    // The download lands in `staging/<variant>/`, not in `models/<variant>/`:
    // it takes minutes and the analyzer must keep answering from the current
    // variant while it runs. Only the final swap touches the installed files.
    let staging = root.join("staging").join(&variant);
    std::fs::create_dir_all(&staging).map_err(err)?;
    let files = fetch(&app, &staging, &variant).await?;
    // The swap renames the directory the loaded sessions map, and activates the
    // newly installed variant atomically under the install gate so no running
    // analysis can write spans under the wrong weights fingerprint.
    let state: Option<tauri::State<AnalyzerState>> = app.try_state::<AnalyzerState>();
    let clone = root.clone();
    if let Some(state) = &state {
        let fresh = variant.clone();
        let app_ref = &app;
        state
            .while_installing(async move {
                state.unload().await;
                commit(&clone, &fresh, &files)?;
                crate::settings::write_active_variant(app_ref, Some(&fresh))
            })
            .await?;
    } else {
        commit(&root, &variant, &files)?;
        crate::settings::write_active_variant(&app, Some(&variant))?;
    }
    // A status refresh, not a second install step: the sizes come from the
    // network, and a flaky connection must not turn a finished install into an
    // error the user would read as "the download failed".
    Ok(status_of(&app, &root, fetch_manifest().await))
}

/// Make `variant` the one the reader loads.
#[tauri::command]
pub async fn models_activate<R: Runtime>(app: AppHandle<R>, variant: String) -> Result<Status> {
    if !is_variant(&variant) {
        return Err(format!("未知的模型版本 {variant}"));
    }
    let root = root(&app)?;
    let activate_inner = || -> Result<()> {
        if installed(&root.join(&variant)).is_none() {
            return Err(format!("models-missing: {variant} 没有安装在磁盘上"));
        }
        crate::settings::write_active_variant(&app, Some(&variant))
    };
    // Serialize with install/remove (`while_installing_model`) and with session
    // loading (`while_installing`) so the disk check, active choice, and session
    // unload happen atomically without racing a running inference job.
    if let Some(state) = app.try_state::<AnalyzerState>() {
        state
            .while_installing_model(async {
                state
                    .while_installing(async {
                        activate_inner()?;
                        state.unload().await;
                        Ok::<_, String>(())
                    })
                    .await
            })
            .await?;
    } else {
        activate_inner()?;
    }
    Ok(status_of(&app, &root, cached_manifest()))
}

/// Download (or copy, in a debug build) every file of `variant` into `staging`,
/// verified. Returns the `(name, bytes)` pairs the stamp should record.
async fn fetch<R: Runtime>(
    app: &AppHandle<R>,
    staging: &Path,
    variant: &str,
) -> Result<Vec<(String, u64)>> {
    if cfg!(debug_assertions)
        && Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(LOCAL_SOURCE)
            .join(variant)
            .is_dir()
    {
        return install_local(staging, variant);
    }
    let manifest = fetch_manifest().await?;
    let (spec, files) = manifest.files(variant)?;
    // Every path is used as `<variant>/<basename>`, so duplicates land on top
    // of each other and the stamp would list one name twice — a manifest that
    // does that is broken, and installing it would produce weights nobody
    // verified. Resolving names up front rejects it before anything downloads.
    let mut names = Vec::with_capacity(files.len());
    for file in &files {
        let name = basename(&file.path)?;
        if names.contains(&name) {
            return Err(format!("manifest: 文件名重复（{name}）"));
        }
        names.push(name);
    }
    let total = spec.bytes;
    let dir = staging.to_path_buf();
    std::fs::create_dir_all(&dir).map_err(err)?;
    let client = client()?;
    let mut written = Vec::new();
    let mut done = 0u64;
    for (name, file) in names.iter().zip(files.iter()) {
        let name = name.to_string();
        let dest = dir.join(&name);
        let expected_bytes = file.bytes;
        let expected_sha = file.sha256.clone();
        let already_ok = {
            let dest = dest.clone();
            tauri::async_runtime::spawn_blocking(move || {
                std::fs::metadata(&dest).is_ok_and(|meta| {
                    meta.len() == expected_bytes
                        && sha256(&dest).is_ok_and(|got| got == expected_sha)
                })
            })
            .await
            .unwrap_or(false)
        };
        if already_ok {
            // already here, right size, right digest: skip the transfer, keep
            // the stamp honest
            written.push((name.clone(), expected_bytes));
            done += expected_bytes;
            continue;
        }
        let base = done;
        download(client, &file_url(&file.path), &dest, file.bytes, |bytes| {
            let _ = app.emit(
                MODELS_PROGRESS_EVENT,
                Progress {
                    variant: variant.to_string(),
                    file: name.clone(),
                    done: base + bytes,
                    total,
                },
            );
        })
        .await?;
        {
            let dest = dest.clone();
            let file_spec: File = (*file).clone();
            tauri::async_runtime::spawn_blocking(move || verify(&dest, &file_spec))
                .await
                .map_err(err)??;
        }
        written.push((name.clone(), file.bytes));
        done += file.bytes;
    }
    Ok(written)
}

/// Swap `staging` into place.
///
/// The analyzer maps these files, so it is unloaded first: on Windows deleting a
/// file a live session holds open fails outright, and on Linux the unlink
/// succeeds while the old inode stays mapped until the process drops it.
///
/// Order matters more than it looks. The staged tree is hard-linked (or copied)
/// into `<variant>.new` so `staging/` stays intact if swapping fails; `<variant>.new`
/// is then swapped into place as a whole and the old tree is only deleted after
/// the new one is in and stamped.
fn commit(root: &Path, variant: &str, files: &[(String, u64)]) -> Result<()> {
    let staging = root.join("staging").join(variant);
    let dir = root.join(variant);
    let incoming = with_suffix(&dir, ".new");
    let previous = with_suffix(&dir, ".old");
    let _ = std::fs::remove_dir_all(&incoming);
    let _ = std::fs::remove_dir_all(&previous);
    std::fs::create_dir_all(&incoming).map_err(err)?;
    for (name, _) in files {
        let from = staging.join(name);
        let to = incoming.join(name);
        // Hard-link first (O(1), keeps staging intact on rollback), falling
        // back to copy across filesystems.
        std::fs::hard_link(&from, &to)
            .or_else(|_| std::fs::copy(&from, &to).map(|_| ()))
            .map_err(|e| format!("{}: {e}", from.display()))?;
    }
    // The stamp is written after the rename, so it always describes the tree
    // that is in place; `write_stamp` is atomic, so a crash cannot leave a
    // half-written list that `installed()` would trust.
    if dir.exists() {
        std::fs::rename(&dir, &previous)
            .map_err(|e| format!("{}: {e}（旧模型仍在使用？）", dir.display()))?;
    }
    std::fs::rename(&incoming, &dir).map_err(|e| {
        // Put the old one back: leaving neither would strand the app with no
        // weights at all.
        let _ = std::fs::rename(&previous, &dir);
        format!("{}: {e}", incoming.display())
    })?;
    if let Err(e) = write_stamp(&dir, variant, files) {
        // The new tree is in place but unstamped, which `installed()` reads as
        // "not installed". Rolling back is the only state that is both true and
        // usable: the caller reports the error, and the old weights still work.
        let _ = std::fs::rename(&dir, &incoming);
        let _ = std::fs::rename(&previous, &dir);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(&previous);
    let _ = std::fs::remove_dir_all(&staging);
    sweep_swap_leftovers(&dir);
    Ok(())
}

/// Delete one variant's weights.
#[tauri::command]
pub async fn models_remove<R: Runtime>(app: AppHandle<R>, variant: String) -> Result<Status> {
    if !is_variant(&variant) {
        return Err(format!("未知的模型版本 {variant}"));
    }
    match app.try_state::<AnalyzerState>() {
        Some(state) => {
            state
                .while_installing_model(remove(app.clone(), variant))
                .await
        }
        None => remove(app, variant).await,
    }
}

async fn remove<R: Runtime>(app: AppHandle<R>, variant: String) -> Result<Status> {
    let root = root(&app)?;
    let dir = root.join(&variant);
    let clear = || {
        let _ = std::fs::remove_dir_all(&dir);
        // A swap that died between renames leaves these behind.
        let _ = std::fs::remove_dir_all(with_suffix(&dir, ".new"));
        let _ = std::fs::remove_dir_all(with_suffix(&dir, ".old"));
    };
    // Same ordering as an install: drop the sessions, then unlink the files
    // they hold mapped (Windows refuses to delete an open file). Removing a
    // variant that is not loaded also clears the cache, but separating that
    // case costs more than the cold load it saves.
    if let Some(state) = app.try_state::<AnalyzerState>() {
        state
            .while_installing(async {
                state.unload().await;
                clear();
            })
            .await;
    } else {
        clear();
    }
    // Removing the active variant clears the choice: quietly pointing at a
    // directory that is gone would make `installed_dir` fall back to whatever
    // it finds, which is not what "I removed this" promised.
    if crate::settings::active_variant(&app).as_deref() == Some(variant.as_str()) {
        crate::settings::write_active_variant(&app, None)?;
    }
    // The stamp is gone, so `installed()` now reports nothing even if Windows
    // kept a mapped file alive: the app is consistent with what the user asked
    // for, and the leftover is reclaimed by the next install's rename.
    let mut status = status_of(&app, &root, cached_manifest());
    // Say so when the weights are still on disk. The stamp is deleted, so the
    // app behaves as uninstalled either way — but "removed" while 200 MB of
    // weights remain is not something to be quiet about.
    if dir_bytes(&dir) > 0 {
        status.warning = Some(format!(
            "{} 已停用，但权重文件还留在磁盘上（可能被系统占用），下次安装会覆盖它们。",
            variant
        ));
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, bytes: u64) -> File {
        File {
            path: path.into(),
            bytes,
            sha256: "00".into(),
        }
    }

    fn manifest() -> Manifest {
        Manifest {
            schema: 1,
            tables: vec![file("vocab.txt", 3)],
            variants: BTreeMap::from([(
                "int8".to_string(),
                Variant {
                    label: "省流".into(),
                    description: String::new(),
                    bytes: 10,
                    files: vec![file("int8/biocn_tok.ort", 7)],
                },
            )]),
        }
    }

    #[test]
    fn a_variant_pulls_the_shared_tables_too() {
        let manifest = manifest();
        let (spec, files) = manifest.files("int8").expect("variant");
        assert_eq!(spec.label, "省流");
        assert_eq!(
            files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["vocab.txt", "int8/biocn_tok.ort"]
        );
    }

    #[test]
    fn an_unknown_variant_is_rejected() {
        let manifest = manifest();
        assert!(manifest.files("fp8").is_err());
    }

    #[test]
    fn only_the_basename_of_a_manifest_path_reaches_the_disk() {
        assert_eq!(
            basename("fp16/biocn_dep.ort").expect("name"),
            "biocn_dep.ort"
        );
        assert_eq!(basename("vocab.txt").expect("name"), "vocab.txt");
        assert!(basename("../escape").is_err());
        assert!(basename("int8/").is_err());
        assert!(basename(".hidden").is_err());
    }

    #[test]
    fn the_part_file_keeps_the_original_name() {
        let dest = Path::new("/tmp/models/int8/biocn_tok.ort");
        assert_eq!(
            part_path(dest),
            Path::new("/tmp/models/int8/biocn_tok.ort.part")
        );
    }

    /// A manifest the binary was not built against is refused, not parsed: the
    /// weights are only as trustworthy as the digest list inside it.
    #[test]
    fn a_manifest_that_is_not_the_pinned_one_is_refused() {
        let err = parse_manifest("{\"schema\":1}").expect_err("must refuse");
        assert!(err.contains("校验失败"), "{err}");
    }

    /// Failing to reach the manifest is a fact about the sizes, not a failure
    /// of whatever operation asked: an install that finished must not report an
    /// error just because the network dropped afterwards. `status_of` needs an
    /// app handle only to read the active choice, which the fake app below has
    /// none of — an empty settings file, so nothing is active.
    #[test]
    fn a_status_without_a_manifest_still_reports_what_is_installed() {
        let app = tauri::test::mock_app();
        let root = std::env::temp_dir().join(format!("biocn-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        install_fixture(&root, "int8", 7);
        let status = status_of(app.handle(), &root, Err("offline".into()));
        assert_eq!(status.installed, vec!["int8".to_owned()]);
        assert_eq!(status.active, None);
        let int8 = status
            .variants
            .iter()
            .find(|v| v.id == "int8")
            .expect("row");
        assert!(int8.size > 0);
        assert_eq!(status.manifest_error.as_deref(), Some("offline"));
        // Without sizes from the manifest the two rows still exist, so the page
        // can offer both variants instead of an empty list.
        assert_eq!(status.variants.len(), 2);
        assert!(status.variants.iter().all(|variant| variant.bytes == 0));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A stamped variant directory with every required weight at `len` bytes.
    fn install_fixture(root: &Path, variant: &str, len: u64) {
        let dir = root.join(variant);
        std::fs::create_dir_all(&dir).expect("dir");
        let mut files = Vec::new();
        for name in REQUIRED {
            std::fs::write(dir.join(name), vec![1u8; len as usize]).expect("write");
            files.push((name.to_string(), len));
        }
        write_stamp(&dir, variant, &files).expect("stamp");
    }

    #[test]
    fn a_stamp_with_every_file_present_installs() {
        let dir = std::env::temp_dir().join(format!("biocn-stamp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        install_fixture(&dir, "int8", 7);
        assert_eq!(installed(&dir.join("int8")).as_deref(), Some("int8"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A stamp that lists only some of the weights describes a partial install
    /// — an interrupted download, or a release that changed its file list. It
    /// must not count as installed, or the analyzer maps a directory that is
    /// missing `biocn_dep.ort`.
    #[test]
    fn a_stamp_missing_a_weight_does_not_install() {
        let dir = std::env::temp_dir().join(format!("biocn-stamp-part-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        install_fixture(&dir, "int8", 7);
        std::fs::write(dir.join("int8/stamp"), "int8\nbiocn_tok.ort 7").expect("stamp");
        assert_eq!(installed(&dir.join("int8")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stamp_whose_file_was_deleted_does_not_install() {
        let dir = std::env::temp_dir().join(format!("biocn-stamp-gone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        install_fixture(&dir, "int8", 7);
        std::fs::remove_file(dir.join("int8/biocn_tok.ort")).expect("remove");
        assert_eq!(installed(&dir.join("int8")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stamp_for_an_unknown_variant_is_ignored() {
        let dir = std::env::temp_dir().join(format!("biocn-stamp-odd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("fp8")).expect("dir");
        std::fs::write(dir.join("fp8/stamp"), "fp8").expect("stamp");
        assert_eq!(installed(&dir.join("fp8")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Both variants on disk at once is the whole point of per-variant stamps:
    /// neither install invalidates the other's.
    #[test]
    fn two_variants_installed_together_both_count() {
        let dir = std::env::temp_dir().join(format!("biocn-stamp-both-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        install_fixture(&dir, "int8", 7);
        install_fixture(&dir, "fp16", 9);
        assert_eq!(installed(&dir.join("int8")).as_deref(), Some("int8"));
        assert_eq!(installed(&dir.join("fp16")).as_deref(), Some("fp16"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The swap is the only part of an install that touches installed files, so
    /// it is the part worth pinning: staged files move in, the stamp appears,
    /// and the other variant's install is left untouched.
    #[test]
    fn committing_staging_replaces_the_installed_variant() {
        let root = std::env::temp_dir().join(format!("biocn-commit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        install_fixture(&root, "int8", 7);
        let staging = root.join("staging/fp16");
        std::fs::create_dir_all(&staging).expect("staging");
        let mut files = Vec::new();
        for name in REQUIRED {
            std::fs::write(staging.join(name), vec![2u8; 9]).expect("staged");
            files.push((name.to_string(), 9));
        }

        commit(&root, "fp16", &files).expect("commit");

        assert_eq!(installed(&root.join("fp16")).as_deref(), Some("fp16"));
        assert_eq!(
            std::fs::read(root.join("fp16/biocn_tok.ort")).expect("moved"),
            vec![2u8; 9]
        );
        // The other variant must survive a commit: both installed at once is
        // what lets the reader switch without a download.
        assert!(root.join("int8").exists(), "另一个变体应当保留");
        assert!(!root.join("staging/fp16").exists(), "staging 应当被清空");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The point of the three-way swap: a failure before the new tree is in
    /// place must leave the working installation alone, not a half-filled
    /// directory the analyzer would then map.
    #[test]
    fn a_failed_swap_keeps_the_installed_variant() {
        let root = std::env::temp_dir().join(format!("biocn-commit-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        install_fixture(&root, "int8", 7);
        // fp16 was never staged, so moving its files in fails.
        let err = commit(&root, "fp16", &[("biocn_tok.ort".into(), 9)]).expect_err("must fail");
        assert!(err.contains("biocn_tok.ort"), "{err}");
        assert_eq!(
            installed(&root.join("int8")).as_deref(),
            Some("int8"),
            "旧安装必须还在"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_truncated_file_does_not_install() {
        let dir = std::env::temp_dir().join(format!("biocn-stamp-short-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        install_fixture(&dir, "int8", 7);
        std::fs::write(dir.join("int8/biocn_tok.ort"), vec![1u8; 5]).expect("write");
        assert_eq!(installed(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
