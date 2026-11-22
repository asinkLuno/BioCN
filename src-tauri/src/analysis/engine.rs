//! Native inference: the three BioCN graphs on ONNX Runtime (`ort` crate).
//!
//! Every platform links ORT at run time (`load-dynamic`): the app ships a
//! *minimal-build* `libonnxruntime` library (only the kernels these three
//! graphs use, no ONNX parser, a few MB instead of the 15 MB of ExecutionProvider
//! code the full binary carries on desktop / 34 MB on Android). It can therefore
//! only load ORT-format models, hence `.ort` below (`tools/convert_ort.py`).
//! Android finds it by bare SONAME through bionic's app namespace
//! (`jniLibs`); desktop finds it next to the executable (`builder` below).
//!
//! `Session::run` needs `&mut self`, so each graph sits behind a `Mutex` — the
//! three graphs still run independently of each other.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use ort::environment::Environment;
use ort::session::Session;
use ort::value::Tensor;

use crate::analysis::resources::{Error, Result};

pub struct Sessions {
    tok: Mutex<Session>,
    pos: Mutex<Session>,
    dep: Mutex<Session>,
}

impl Sessions {
    /// Opens `biocn_{tok,pos,dep}.ort` from `dir`.
    ///
    /// ORT format (not `.onnx`) because the shipped `libonnxruntime.so` is a
    /// minimal build: it carries only the kernels these three graphs need and
    /// no ONNX parser at all, which is what takes it from 34 MB to 6 MB. The
    /// app downloads the weights (`src/models.rs`); `tools/convert_ort.py`
    /// produces both variants it offers.
    pub fn load(dir: &Path) -> Result<Self> {
        let env = environment()?;
        Ok(Self {
            tok: Mutex::new(session(env, &dir.join("biocn_tok.ort"))?),
            pos: Mutex::new(session(env, &dir.join("biocn_pos.ort"))?),
            dep: Mutex::new(session(env, &dir.join("biocn_dep.ort"))?),
        })
    }
}

/// One ORT environment per process; `EnvironmentBuilder::build` rejects a
/// second one. Init is serialized so concurrent first calls cannot race.
fn environment() -> Result<&'static Environment> {
    static ENV: OnceLock<Environment> = OnceLock::new();
    static INIT: Mutex<()> = Mutex::new(());

    if let Some(env) = ENV.get() {
        return Ok(env);
    }
    let _guard = INIT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(env) = ENV.get() {
        return Ok(env);
    }
    // Telemetry defaults to on in `ort`; we do not want it in an offline reader.
    let env = builder()?
        .with_name("biocn-reader")
        .with_telemetry(false)
        .build()
        .map_err(oerr)?;
    Ok(ENV.get_or_init(|| env))
}

#[cfg(target_os = "android")]
fn builder() -> Result<ort::environment::EnvironmentBuilder> {
    // Bare SONAME: bionic resolves it from the app's nativeLibraryDir. A path in
    // ORT_DYLIB_PATH overrides it (handy when debugging a side-loaded build).
    let dylib = std::env::var("ORT_DYLIB_PATH").unwrap_or_else(|_| "libonnxruntime.so".into());
    ort::init_from(dylib).map_err(oerr)
}

#[cfg(not(target_os = "android"))]
fn builder() -> Result<ort::environment::EnvironmentBuilder> {
    // Desktop also loads ORT at run time: the app ships a minimal-build
    // `libonnxruntime(.so/.dylib/.dll)` next to the executable (a few MB instead
    // of the 15 MB of ExecutionProviders statically linked by `download-binaries`).
    // `ORT_DYLIB_PATH` overrides it for debugging; bare SONAME covers system
    // installs. Same file works for any variant of the shipped models.
    if let Ok(path) = std::env::var("ORT_DYLIB_PATH") {
        return ort::init_from(path).map_err(oerr);
    }
    if let Some(ort) = std::env::current_exe().ok().and_then(|exe| {
        exe.parent()?.read_dir().ok()?.flatten().find(|entry| {
            matches!(
                entry.file_name().to_string_lossy().as_ref(),
                "libonnxruntime.so" | "libonnxruntime.dylib" | "libonnxruntime.dll"
            )
        })
    }) {
        return ort::init_from(ort.path()).map_err(oerr);
    }
    ort::init_from("libonnxruntime.so").map_err(oerr)
}

/// Enough threads to matter, few enough not to fight the UI thread.
///
/// The pipeline runs three sessions concurrently (TOK / POS / DEP), so total
/// active ORT threads is roughly `3 * intra`:
/// - Android (big.LITTLE + thermal budget): 1 per session (3 total) to avoid
///   spilling onto efficiency cores and stalling barrier syncs.
/// - Desktop with <= 5 logical cores (e.g. 2–4 core laptops): 1 per session
///   (3 total) so UI/WebView keeps headroom instead of 150% oversubscription.
/// - Desktop with >= 6 logical cores: 2 per session (6 total) — measured on
///   desktop (9700X, int8, per stage), 2 is the sweet spot and it falls off
///   monotonically past that (3 intra threads -6%, 4 -12%), while the old
///   serial layout cratered at 8 (-65%).
///
/// `ORT_INTRA_THREADS` overrides the default — same spirit as `ORT_DYLIB_PATH`:
/// a knob for benches and odd hardware, read when a session commits, so a bench
/// can reload per configuration.
fn threads() -> usize {
    let overridden = std::env::var("ORT_INTRA_THREADS")
        .ok()
        .and_then(|n| n.parse::<usize>().ok());
    if let Some(n) = overridden.filter(|n| *n >= 1) {
        return n;
    }
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    default_intra_threads(cores, cfg!(target_os = "android"))
}

fn default_intra_threads(available_cores: usize, is_android: bool) -> usize {
    if is_android {
        return 1;
    }
    if available_cores >= 6 { 2 } else { 1 }
}

fn session(env: &'static Environment, path: &Path) -> Result<Session> {
    let builder = Session::builder(env).map_err(oerr)?;
    let builder = builder.with_intra_threads(threads()).map_err(oerr)?;
    let builder = builder.with_inter_threads(1).map_err(oerr)?;
    // The high-accuracy variant is an fp16 model converted in *Runtime* style:
    // its graph optimizations are saved as instructions and replayed at load.
    // Fixed style would be simpler, but ORT dequantizes fp16 while optimizing,
    // so that file is 137 MB — twice the int8 one. Turning the flag on for the
    // int8 variant too is a no-op (it saves no runtime optimizations), which is
    // what lets one code path load whichever variant is installed.
    let builder = builder
        .with_saved_runtime_optimizations(true)
        .map_err(oerr)?;
    let mut builder = builder;
    builder.commit_from_file(path).map_err(oerr)
}

/// `ort` errors are not `Send + Sync` in every case (the builder variants carry
/// raw pointers), so flatten them to a message at the boundary.
fn oerr<E: std::fmt::Debug + std::fmt::Display>(e: E) -> Error {
    format!("onnxruntime: {e}").into()
}

fn lock(session: &Mutex<Session>) -> std::sync::MutexGuard<'_, Session> {
    // A panicking run must not poison the analyzer for the rest of the session.
    session.lock().unwrap_or_else(|e| e.into_inner())
}

fn ids_tensor(shape: (i64, i64), ids: &[i64]) -> Result<Tensor<i64>> {
    Tensor::from_array((vec![shape.0, shape.1], ids.to_vec())).map_err(oerr)
}

/// The three model calls as plain methods; `pipeline.rs` documents why there
/// is no runner trait (no mocks exist; reintroduce one for tensor-replay
/// tests).
impl Sessions {
    pub fn run_tok(&self, input_ids: &[i64], shape: (i64, i64)) -> Result<Vec<f32>> {
        let input = ids_tensor(shape, input_ids)?;
        let mut session = lock(&self.tok);
        let outputs = session.run(ort::inputs![input]).map_err(oerr)?;
        let (_, logits) = outputs[0].try_extract_tensor::<f32>().map_err(oerr)?;
        Ok(logits.to_vec())
    }

    pub fn run_pos(
        &self,
        input_ids: &[i64],
        ids_shape: (i64, i64),
        token_span: &[i64],
        span_shape: (i64, i64, i64),
    ) -> Result<Vec<f32>> {
        let input = ids_tensor(ids_shape, input_ids)?;
        let span = Tensor::from_array((
            vec![span_shape.0, span_shape.1, span_shape.2],
            token_span.to_vec(),
        ))
        .map_err(oerr)?;
        let mut session = lock(&self.pos);
        let outputs = session.run(ort::inputs![input, span]).map_err(oerr)?;
        let (_, logits) = outputs[0].try_extract_tensor::<f32>().map_err(oerr)?;
        Ok(logits.to_vec())
    }

    pub fn run_dep(
        &self,
        input_ids: &[i64],
        ids_shape: (i64, i64),
        token_span: &[i64],
        span_shape: (i64, i64, i64),
        mask: &[u8],
    ) -> Result<(Vec<f32>, Vec<f32>)> {
        let input = ids_tensor(ids_shape, input_ids)?;
        let span = Tensor::from_array((
            vec![span_shape.0, span_shape.1, span_shape.2],
            token_span.to_vec(),
        ))
        .map_err(oerr)?;
        let mask = Tensor::from_array((
            vec![ids_shape.0, mask.len() as i64],
            mask.iter().map(|m| *m != 0).collect::<Vec<bool>>(),
        ))
        .map_err(oerr)?;
        let mut session = lock(&self.dep);
        let outputs = session.run(ort::inputs![input, span, mask]).map_err(oerr)?;
        let (_, s_arc) = outputs[0].try_extract_tensor::<f32>().map_err(oerr)?;
        let (_, s_rel) = outputs[1].try_extract_tensor::<f32>().map_err(oerr)?;
        Ok((s_arc.to_vec(), s_rel.to_vec()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_budget_avoids_oversubscription_on_small_desktop_and_android() {
        // Android always caps at 1 intra thread per session (3 total across
        // the 3-stage pipeline) regardless of core count.
        assert_eq!(default_intra_threads(4, true), 1);
        assert_eq!(default_intra_threads(8, true), 1);
        assert_eq!(default_intra_threads(12, true), 1);

        // Desktop <= 5 logical cores uses 1 per session (3 total) to leave UI headroom.
        assert_eq!(default_intra_threads(1, false), 1);
        assert_eq!(default_intra_threads(2, false), 1);
        assert_eq!(default_intra_threads(4, false), 1);
        assert_eq!(default_intra_threads(5, false), 1);

        // Desktop >= 6 logical cores uses the measured 2-per-session sweet spot (6 total).
        assert_eq!(default_intra_threads(6, false), 2);
        assert_eq!(default_intra_threads(8, false), 2);
        assert_eq!(default_intra_threads(16, false), 2);
    }
}
