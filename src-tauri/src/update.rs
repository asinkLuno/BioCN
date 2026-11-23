//! 设置页"版本与更新"的后端（前端 `src/components/UpdateSection.tsx`）。
//!
//! 元数据来自发布页的 `releases.json`：发布流程（scripts/pages-release.mjs）
//! 从 GitHub Releases API 生成它并随 GitHub Pages 部署，带每个附件的
//! SHA-256，所以检查更新不需要调用有速率限制的 GitHub API。安装包字节
//! 本身来自 `github.com/…/releases/download/`，边下边算 SHA-256。

use crate::net::{CancelSlot, race_cancel};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 发布流程随 Pages 部署的元数据（ BioCN 安装包的清单）。
const RELEASES_URL: &str = "https://asinkluno.github.io/BioCN/releases.json";
/// 安装包只接受这个仓库的 GitHub Release 附件，绝不下载任意链接。
const DOWNLOAD_PREFIX: &str = "https://github.com/asinkLuno/BioCN/releases/download/";
/// 检查失败或当前平台缺少官方安装包时展示的发布页。
const RELEASES_PAGE: &str = "https://github.com/asinkLuno/BioCN/releases/latest";
/// 下载进度事件：`{ received, total }`，total 未知时为 0。前端
/// （`src/lib/update.ts`）监听同一个字面量。
pub const UPDATE_PROGRESS_EVENT: &str = "update://progress";

/// 发布流程能生成的安装包扩展名（pages-release.mjs 的平台分类），
/// 之外的 `releases.json` 条目一律不提供。
const ASSET_EXTENSIONS: [&str; 6] = [
    ".apk", ".exe", ".msi", ".dmg", ".deb", ".rpm",
];

#[derive(Debug, Deserialize)]
struct WebsiteAsset {
    // 文件名一律从 download_url 推导并校验，releases.json 里的 name 字段不参与。
    platform: String,
    size: u64,
    #[serde(default)]
    sha256: Option<String>,
    download_url: String,
}

#[derive(Debug, Deserialize)]
struct WebsiteRelease {
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    downloads: Vec<WebsiteAsset>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub name: String,
    pub platform: String,
    pub size: u64,
    /// releases.json 记录的安装包 SHA-256（小写十六进制），缺失则拒绝应用内下载。
    pub sha256: Option<String>,
    pub url: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub version: String,
    pub notes: String,
    /// 该 Release 的全部官方安装包，保持 releases.json 的顺序。
    pub downloads: Vec<AssetInfo>,
    /// 当前平台对应的安装包（桌面端与 Android 均支持应用内下载）；
    /// 仅当该平台没有对应产物时为 None，前端回退到发布页链接。
    pub download: Option<AssetInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub latest: Option<ReleaseInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPermission {
    pub supported: bool,
    pub granted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub received: u64,
    pub total: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub path: String,
    pub bytes: u64,
}

/// 校验值来自 releases.json，只接受 64 位十六进制，避免空值或脏数据绕过校验。
fn normalize_sha256(value: &Option<String>) -> Option<String> {
    let value = value.as_deref()?.trim().to_ascii_lowercase();
    (value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())).then_some(value)
}

/// 安装包文件名只允许发布流程生成的 `BioCN_<版本>…<扩展名>`；带分隔符、
/// `..` 或陌生前缀的地址（releases.json 被篡改时）到不了文件系统。
fn asset_file_name(url: &str) -> Option<String> {
    let legal = |c: char| c.is_ascii_alphanumeric() || "._-".contains(c);
    let relative = url.strip_prefix(DOWNLOAD_PREFIX)?;
    let (tag, asset) = relative.split_once('/')?;
    if tag.is_empty()
        || asset.contains('/')
        || asset.contains("..")
        || !asset.starts_with("BioCN_")
        || !ASSET_EXTENSIONS.iter().any(|ext| asset.ends_with(ext))
        || !tag.chars().all(legal)
        || !asset.chars().all(legal)
    {
        return None;
    }
    Some(asset.to_string())
}

/// 当前平台应提供的安装包：releases.json 里该平台的第一项——扩展名的
/// 优先级（Windows .exe 先于 .msi，Linux .deb 先于 RPM）由发布脚本
/// 排序，这里只取顺序。`os` 是参数以便测试；调用处传运行平台的 OS。
fn pick_for(os: &str, assets: &[AssetInfo]) -> Option<AssetInfo> {
    assets.iter().find(|asset| asset.platform == os).cloned()
}

fn release_info(release: &WebsiteRelease) -> Option<ReleaseInfo> {
    let downloads: Vec<AssetInfo> = release
        .downloads
        .iter()
        .filter_map(|asset| {
            asset_file_name(&asset.download_url).map(|name| AssetInfo {
                name,
                platform: asset.platform.clone(),
                size: asset.size,
                sha256: normalize_sha256(&asset.sha256),
                url: asset.download_url.clone(),
            })
        })
        .collect();
    // 没有官方安装包的 Release 对更新界面毫无用处。
    if downloads.is_empty() {
        return None;
    }
    let download = pick_for(std::env::consts::OS, &downloads);
    Some(ReleaseInfo {
        version: release.version.clone(),
        notes: release.notes.clone(),
        downloads,
        download,
    })
}

fn build_status(current_version: &str, releases: &[WebsiteRelease]) -> UpdateStatus {
    // pages-release.mjs 按 published_at 倒序写出，第一项就是最新版。
    UpdateStatus {
        current_version: current_version.to_string(),
        latest: releases.first().and_then(release_info),
    }
}

// reqwest 的 Display 只包含请求地址，保留 source 链才能区分 DNS、TLS 和连接错误。
fn request_error(error: &reqwest::Error) -> String {
    use std::error::Error;
    let mut details = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        details.push_str(": ");
        details.push_str(&cause.to_string());
        source = cause.source();
    }
    let hint = if error.is_timeout() {
        "请求超时，请检查网络后重试"
    } else if error.is_connect() {
        "连接发布页失败，请检查网络、代理及系统时间"
    } else {
        "无法获取更新信息"
    };
    format!("{hint}：{details}")
}

/// 检查发布页的更新信息。GitHub Pages 直接服务这个文件，因此拒绝重定向：
/// 一个被劫持的解析结果无法把元数据挪到别的站点。
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    let client = crate::net::update_check_client()?;
    let body = client
        .get(RELEASES_URL)
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| request_error(&error))?
        .text()
        .await
        .map_err(|error| format!("无法读取更新信息：{error}"))?;
    let releases: Vec<WebsiteRelease> =
        serde_json::from_str(&body).map_err(|error| format!("更新信息解析失败：{error}"))?;
    Ok(build_status(&current_version, &releases))
}

/// Serializes in-app installer downloads so two clicks cannot interleave the
/// same `.part` file.
static DOWNLOAD_LOCK: std::sync::OnceLock<tauri::async_runtime::Mutex<()>> =
    std::sync::OnceLock::new();

fn cancel_slot() -> &'static CancelSlot {
    static SLOT: std::sync::OnceLock<CancelSlot> = std::sync::OnceLock::new();
    SLOT.get_or_init(CancelSlot::default)
}

#[cfg(target_os = "android")]
struct AndroidInstaller(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
#[derive(Debug, Deserialize)]
struct EmptyResponse {}

/// 注册 Android 侧原生安装插件（`ApkInstallerPlugin`）。
#[cfg(target_os = "android")]
pub fn android_installer_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("apk-installer")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("io.github.asinkluno.biocn", "ApkInstallerPlugin")?;
            app.manage(AndroidInstaller(handle));
            Ok(())
        })
        .build()
}

/// 下载目录：应用缓存内的 `updates/`，属于派生数据，系统可随时清理。
fn download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法定位缓存目录：{error}"))?
        .join("updates");
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建下载目录：{error}"))?;
    Ok(dir)
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 若缓存目录里已有同名安装包且 SHA-256 与期望一致，返回其字节数以便直接复用。
fn verified_existing_file(path: &Path, expected_sha256: &str) -> Option<u64> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    (hex_digest(&hasher.finalize()) == expected_sha256).then_some(total)
}

fn validate_update_file_in_dir(
    dir: &Path,
    path: &str,
    required_ext: Option<&str>,
) -> Result<PathBuf, String> {
    let dir = dir
        .canonicalize()
        .map_err(|error| format!("无法定位下载目录：{error}"))?;
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("无法定位安装包：{error}"))?;
    if !canonical.is_file() || canonical.parent() != Some(dir.as_path()) {
        return Err("只能操作应用下载的安装包".to_string());
    }
    if let Some(ext) = required_ext {
        let matches = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(ext));
        if !matches {
            return Err("安装包格式无效".to_string());
        }
    }
    Ok(canonical)
}

/// 取消正在进行的安装包下载。
#[tauri::command]
pub fn cancel_update_download() -> bool {
    cancel_slot().cancel()
}

/// 应用内下载安装包，边写边算 SHA-256；校验不通过的文件不会留在磁盘上。
/// 读超时（models.rs 同款）兜底"连上了却不发数据"的 CDN，传输继续时不会
/// 被总超时误杀。
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    url: String,
    sha256: String,
) -> Result<DownloadResult, String> {
    let lock = DOWNLOAD_LOCK.get_or_init(|| tauri::async_runtime::Mutex::new(()));
    let _guard = lock
        .try_lock()
        .map_err(|_| "安装包正在下载中，请稍候".to_string())?;
    let cancel_guard = cancel_slot().begin();
    let cancel = cancel_guard.token();

    let expected = normalize_sha256(&Some(sha256))
        .ok_or_else(|| "更新信息缺少有效的 SHA-256 校验值".to_string())?;
    let file_name = asset_file_name(&url).ok_or_else(|| "下载地址不是官方发布包".to_string())?;
    let dir = download_dir(&app)?;
    let target = dir.join(&file_name);
    let partial = dir.join(format!("{file_name}.part"));

    // 已经完整下载并匹配同一 SHA-256 的缓存包直接复用（例如去系统设置授权后返回重试）。
    if target.is_file() {
        let check_path = target.clone();
        let check_sha = expected.clone();
        if let Ok(Some(bytes)) =
            tauri::async_runtime::spawn_blocking(move || verified_existing_file(&check_path, &check_sha))
                .await
        {
            let _ = app.emit(
                UPDATE_PROGRESS_EVENT,
                DownloadProgress { received: bytes, total: bytes },
            );
            return Ok(DownloadResult { path: target.to_string_lossy().into_owned(), bytes });
        }
    }

    let client = crate::net::update_download_client()?;
    let mut response = race_cancel(cancel, client.get(&url).send())
        .await?
        .and_then(|response| response.error_for_status())
        .map_err(|error| request_error(&error))?;

    let total = response.content_length().unwrap_or(0);
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut written =
        std::fs::File::create(&partial).map_err(|error| format!("无法写入安装包：{error}"))?;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut emit_progress = |received: u64| {
        // 每 120 ms 最多一条事件：进度条够顺滑，又不至于淹没 webview。
        if last_emit.elapsed() >= Duration::from_millis(120) {
            last_emit = Instant::now();
            let _ = app.emit(UPDATE_PROGRESS_EVENT, DownloadProgress { received, total });
        }
    };
    emit_progress(0);

    let write_result = async {
        while let Some(chunk) = race_cancel(cancel, response.chunk())
            .await?
            .map_err(|error| request_error(&error))?
        {
            hasher.update(&chunk);
            written.write_all(&chunk).map_err(|error| format!("无法写入安装包：{error}"))?;
            received += chunk.len() as u64;
            emit_progress(received);
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = write_result {
        drop(written);
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    if let Err(error) = written.flush().and_then(|_| written.sync_all()) {
        drop(written);
        let _ = std::fs::remove_file(&partial);
        return Err(format!("无法写入安装包：{error}"));
    }
    drop(written);

    let actual = hex_digest(&hasher.finalize());
    if actual != expected {
        let _ = std::fs::remove_file(&partial);
        let _ = std::fs::remove_file(&target);
        return Err(format!(
            "安装包校验失败：SHA-256 不匹配（期望 {expected}，实际 {actual}），请重新下载"
        ));
    }
    if let Err(error) = std::fs::rename(&partial, &target) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("无法保存安装包：{error}"));
    }
    let _ = app.emit(
        UPDATE_PROGRESS_EVENT,
        DownloadProgress { received, total: total.max(received) },
    );
    Ok(DownloadResult { path: target.to_string_lossy().into_owned(), bytes: received })
}

/// 在文件管理器里显示下载完成的安装包。路径必须是本模块刚下载的文件：
/// `updates/` 之外的路径（以及 `updates/` 目录本身）一律拒绝。
#[tauri::command]
pub async fn reveal_update(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = download_dir(&app)?;
        let canonical = validate_update_file_in_dir(&dir, &path, None)?;
        app.opener()
            .reveal_item_in_dir(&canonical)
            .map_err(|error| format!("无法打开文件管理器：{error}"))
    })
    .await
    .map_err(|error| format!("无法打开文件管理器：{error}"))?
}

/// 查询 Android「安装未知应用」权限状态；桌面端返回 `supported: false`。
#[tauri::command]
pub async fn install_permission(app: AppHandle) -> Result<InstallPermission, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<AndroidInstaller>()
                .0
                .run_mobile_plugin::<InstallPermission>("installPermission", ())
                .map_err(|error| format!("无法查询安装权限：{error}"))
        })
        .await
        .map_err(|error| format!("无法查询安装权限：{error}"))?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(InstallPermission { supported: false, granted: false })
    }
}

/// 打开 Android「安装未知应用」系统设置页。
#[tauri::command]
pub async fn open_install_permission_settings(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<AndroidInstaller>()
                .0
                .run_mobile_plugin::<EmptyResponse>("openInstallPermissionSettings", ())
                .map(|_| ())
                .map_err(|error| format!("无法打开安装授权设置：{error}"))
        })
        .await
        .map_err(|error| format!("无法打开安装授权设置：{error}"))?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("仅支持 Android".to_string())
    }
}

/// 把已通过 SHA-256 校验的 APK 交给 Android 系统安装器。
#[tauri::command]
pub async fn install_apk(app: AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let dir = download_dir(&app)?;
            let canonical = validate_update_file_in_dir(&dir, &path, Some(".apk"))?;
            let canonical_path = canonical.to_string_lossy().into_owned();
            app.state::<AndroidInstaller>()
                .0
                .run_mobile_plugin::<EmptyResponse>(
                    "installApk",
                    serde_json::json!({ "path": canonical_path }),
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| format!("无法启动系统安装器：{error}"))?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, path);
        Err("应用内安装仅支持 Android".to_string())
    }
}

/// 在浏览器打开 GitHub Releases 页：当前平台没有应用内下载或检查失败时的兜底。
#[tauri::command]
pub async fn open_release_page(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.opener()
            .open_url(RELEASES_PAGE, None::<String>)
            .map_err(|error| format!("无法打开浏览器：{error}"))
    })
    .await
    .map_err(|error| format!("无法打开浏览器：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAG: &str = "https://github.com/asinkLuno/BioCN/releases/download/v0.2.0";

    fn asset(name: &str, platform: &str, sha256: Option<&str>) -> WebsiteAsset {
        WebsiteAsset {
            platform: platform.to_string(),
            size: 1024,
            sha256: sha256.map(str::to_string),
            download_url: format!("{TAG}/{name}"),
        }
    }

    #[test]
    fn sha256_normalization_only_accepts_64_hex_digits() {
        assert_eq!(
            normalize_sha256(&Some("ABCD1234".repeat(8))),
            Some("abcd1234".repeat(8))
        );
        assert_eq!(
            normalize_sha256(&Some(format!(" {} ", "a".repeat(64)))),
            Some("a".repeat(64))
        );
        assert_eq!(normalize_sha256(&Some("z".repeat(64))), None);
        assert_eq!(normalize_sha256(&Some("0".repeat(63))), None);
        assert_eq!(normalize_sha256(&None), None);
    }

    #[test]
    fn asset_names_accept_every_extension_the_release_workflow_produces() {
        for name in [
            "BioCN_0.2.0_arm64.apk",
            "BioCN_0.2.0_x64-setup.exe",
            "BioCN_0.2.0_x64_en-US.msi",
            "BioCN_0.2.0_aarch64.dmg",
            "BioCN_0.2.0_amd64.deb",
            "BioCN_0.2.0_x86_64.rpm",
        ] {
            assert_eq!(asset_file_name(&format!("{TAG}/{name}")).as_deref(), Some(name));
        }
    }

    #[test]
    fn asset_names_refuse_foreign_or_malicious_urls() {
        // 别的仓库、别的发布站点，一概不收。
        assert_eq!(
            asset_file_name("https://github.com/evil/bioCN/releases/download/v1/BioCN_1.0.0.apk"),
            None
        );
        assert_eq!(asset_file_name("https://evil.example.com/BioCN_1.0.0.apk"), None);
        // 路径穿越与陌生文件名。
        assert_eq!(asset_file_name(&format!("{TAG}/../BioCN_1.0.0.apk")), None);
        assert_eq!(asset_file_name(&format!("{TAG}/BioCN_1.0.0.txt")), None);
        assert_eq!(asset_file_name(&format!("{TAG}/Other_1.0.0.apk")), None);
        assert_eq!(asset_file_name(&format!("{TAG}/BioCN_1.0.0..apk")), None);
        // 缺少 tag 或资产名。
        assert_eq!(asset_file_name("https://github.com/asinkLuno/BioCN/releases/download/"), None);
    }

    #[test]
    fn latest_release_picks_the_installer_for_the_running_platform() {
        let release = WebsiteRelease {
            version: "0.2.0".to_string(),
            notes: "说明".to_string(),
            downloads: vec![
                asset("BioCN_0.2.0_arm64.apk", "android", Some("1".repeat(64)).as_deref()),
                asset("BioCN_0.2.0_x64-setup.exe", "windows", Some("2".repeat(64)).as_deref()),
                asset("BioCN_0.2.0_aarch64.dmg", "macos", Some("3".repeat(64)).as_deref()),
                asset("BioCN_0.2.0_amd64.deb", "linux", Some("4".repeat(64)).as_deref()),
            ],
        };
        let info = release_info(&release).expect("a release with official assets");
        assert_eq!(info.version, "0.2.0");
        assert_eq!(info.downloads.len(), 4);
        let picked = info.download.as_ref().expect("an installer for this platform");
        assert_eq!(picked.platform, std::env::consts::OS);
        let expected_sha = match picked.platform.as_str() {
            "windows" => "2".repeat(64),
            "macos" => "3".repeat(64),
            "linux" => "4".repeat(64),
            _ => "1".repeat(64),
        };
        assert_eq!(picked.sha256.as_deref(), Some(expected_sha.as_str()));
    }

    #[test]
    fn android_picks_apk_for_in_app_download_and_unknown_os_stays_none() {
        let sha = "a".repeat(64);
        let release = WebsiteRelease {
            version: "0.2.0".to_string(),
            notes: String::new(),
            downloads: vec![asset("BioCN_0.2.0_arm64.apk", "android", Some(sha.as_str()))],
        };
        let info = release_info(&release).expect("the release is still listed");
        let picked = pick_for("android", &info.downloads).expect("android apk selected");
        assert_eq!(picked.name, "BioCN_0.2.0_arm64.apk");
        assert_eq!(picked.sha256.as_deref(), Some(sha.as_str()));
        assert_eq!(pick_for("freebsd", &info.downloads), None);
    }

    #[test]
    fn verified_existing_file_reuses_matching_digest_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("BioCN_0.6.1_arm64.apk");
        std::fs::write(&file, b"apk-bytes").expect("write");
        let expected = hex_digest(&Sha256::digest(b"apk-bytes"));
        assert_eq!(verified_existing_file(&file, &expected), Some(9));
        assert_eq!(verified_existing_file(&file, &"0".repeat(64)), None);
        assert_eq!(
            verified_existing_file(&dir.path().join("missing.apk"), &expected),
            None
        );
    }

    #[test]
    fn validate_update_file_in_dir_checks_parent_and_extension() {
        let root = tempfile::tempdir().expect("root");
        let updates = root.path().join("updates");
        std::fs::create_dir_all(&updates).expect("mkdir");
        let apk = updates.join("BioCN_0.6.1_arm64.apk");
        let deb = updates.join("BioCN_0.6.1_amd64.deb");
        let outside = root.path().join("BioCN_0.6.1_arm64.apk");
        std::fs::write(&apk, b"a").expect("apk");
        std::fs::write(&deb, b"d").expect("deb");
        std::fs::write(&outside, b"o").expect("outside");

        assert!(
            validate_update_file_in_dir(&updates, apk.to_str().unwrap(), Some(".apk")).is_ok()
        );
        assert!(
            validate_update_file_in_dir(&updates, deb.to_str().unwrap(), Some(".apk")).is_err()
        );
        assert!(
            validate_update_file_in_dir(&updates, deb.to_str().unwrap(), None).is_ok()
        );
        assert!(
            validate_update_file_in_dir(&updates, outside.to_str().unwrap(), Some(".apk")).is_err()
        );
        assert!(
            validate_update_file_in_dir(&updates, updates.to_str().unwrap(), None).is_err()
        );
    }

    #[test]
    fn the_first_asset_of_a_platform_wins_keeping_the_publish_order() {
        // 排序决策在 pages-release.mjs（.exe 先于 .msi）；这里只取第一项。
        let assets = vec![
            AssetInfo {
                name: "BioCN_0.2.0_x64-setup.exe".to_string(),
                platform: "windows".to_string(),
                size: 1,
                sha256: None,
                url: format!("{TAG}/BioCN_0.2.0_x64-setup.exe"),
            },
            AssetInfo {
                name: "BioCN_0.2.0_x64_en-US.msi".to_string(),
                platform: "windows".to_string(),
                size: 1,
                sha256: None,
                url: format!("{TAG}/BioCN_0.2.0_x64_en-US.msi"),
            },
        ];
        assert_eq!(pick_for("windows", &assets).map(|asset| asset.name), Some(assets[0].name.clone()));
    }

    #[test]
    fn releases_without_official_assets_are_skipped() {
        let release = WebsiteRelease {
            version: "0.2.0".to_string(),
            notes: String::new(),
            downloads: vec![asset("BioCN_0.2.0.txt", "windows", None)],
        };
        assert_eq!(release_info(&release), None);
    }

    #[test]
    fn status_reports_the_first_published_release() {
        let releases = vec![
            WebsiteRelease {
                version: "0.2.0".to_string(),
                notes: String::new(),
                downloads: vec![asset("BioCN_0.2.0_amd64.deb", "linux", None)],
            },
            WebsiteRelease {
                version: "0.1.0".to_string(),
                notes: String::new(),
                downloads: vec![asset("BioCN_0.1.0_amd64.deb", "linux", None)],
            },
        ];
        let status = build_status("0.1.0", &releases);
        assert_eq!(status.current_version, "0.1.0");
        assert_eq!(status.latest.expect("latest").version, "0.2.0");
    }
}
