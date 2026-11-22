//! The one thing the app remembers across launches: which model variant to
//! load, persisted as JSON in app data (`{"modelVariant": "fp16"}`).
//!
//! There is no settings page and no settings command: the value is owned by
//! `models.rs`, which reads it when the analyzer loads and writes it when the
//! user activates, installs or removes a variant. The shape stays an object so
//! a later read/write page can reintroduce fields without a migration.
//!
//! Writes are atomic (temp file + rename): a crash mid-write must not leave a
//! truncated file the app then refuses to parse on next launch.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime};

const FILE: &str = "settings.json";

type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The variant the reader loads. `None` means "nothing chosen": with two
    /// variants on disk the first one stands in until the user activates one.
    pub model_variant: Option<String>,
}

/// Read the file, or defaults when it is missing. A malformed file is *not* an
/// error the UI should have to handle: the user cannot fix JSON by hand, so it
/// falls back to defaults and the next write repairs it.
fn load(from: &std::path::Path) -> Settings {
    std::fs::read_to_string(from)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn path<R: Runtime>(app: &impl Manager<R>) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(FILE))
}

/// The variant the user last activated, if the settings file says so.
pub fn active_variant<R: Runtime>(app: &impl Manager<R>) -> Option<String> {
    let file = path(app).ok()?;
    load(&file).model_variant
}

/// Record `variant` as the active one, rewriting the file atomically.
pub fn write_active_variant<R: Runtime>(
    app: &impl Manager<R>,
    variant: Option<&str>,
) -> Result<()> {
    let settings = Settings {
        model_variant: variant.map(str::to_owned),
    };
    let target = path(app)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    // A unique temp per write: two windows can run install/activate/remove
    // concurrently, and a shared `settings.json.tmp` would make one rename
    // fail (or silently lose the loser's write).
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = target.with_extension(format!("json.{}.{}.tmp", std::process::id(), unique));
    let write_result = (|| -> std::io::Result<()> {
        use std::io::Write as _;
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&temporary);
        return Err(e.to_string());
    }
    std::fs::rename(&temporary, &target).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file from an older build carries keys this build dropped (`colorize`,
    /// `theme`, `strictUpstream`); `default` makes serde ignore them and fill
    /// only the keys it knows.
    #[test]
    fn a_file_with_dropped_keys_still_parses() {
        let parsed: Settings = serde_json::from_str(
            r#"{"modelVariant":"int8","colorize":false,"theme":"dark","strictUpstream":true}"#,
        )
        .expect("parse");
        assert_eq!(
            parsed,
            Settings {
                model_variant: Some("int8".into())
            }
        );
    }

    #[test]
    fn an_empty_object_is_the_default() {
        let parsed: Settings = serde_json::from_str("{}").expect("parse");
        assert_eq!(parsed, Settings::default());
    }

    #[test]
    fn a_malformed_file_falls_back_to_defaults_instead_of_failing() {
        let dir = std::env::temp_dir().join(format!("biocn-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let file = dir.join("settings.json");
        std::fs::write(&file, "{not json").expect("write");
        assert_eq!(load(&file), Settings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_round_trip_preserves_every_field() {
        let settings = Settings {
            model_variant: Some("fp16".into()),
        };
        let text = serde_json::to_string(&settings).expect("serialize");
        let parsed: Settings = serde_json::from_str(&text).expect("parse");
        assert_eq!(parsed, settings);
    }

    #[test]
    fn clearing_the_variant_writes_null() {
        let settings = Settings {
            model_variant: None,
        };
        let text = serde_json::to_string(&settings).expect("serialize");
        assert_eq!(text, r#"{"modelVariant":null}"#);
    }
}
