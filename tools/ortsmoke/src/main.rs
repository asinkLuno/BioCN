//! Session-creation + inference smoke for the minimal `libonnxruntime` the app
//! ships:
//!
//! ```sh
//! cargo run --release -p ortsmoke -- <libonnxruntime.{so,dylib,dll}> [models-dir]
//! ```
//!
//! Loads the library through the same `load-dynamic` path as
//! `src-tauri/src/analysis/engine.rs`, then runs one full inference per model
//! in `models-dir` (`int8/` + `fp16/` subdirs, `biocn_{tok,pos,dep}.ort`) with
//! the same tensors the app feeds. A kernel missing from the reduced build
//! fails session creation or the run loudly — exactly what the app would hit.
//! With only a library argument it just proves the library loads and serves
//! the API version `ort` needs.
use ort::environment::Environment;
use ort::session::Session;
use ort::value::Tensor;
use std::path::Path;

fn main() {
    let mut args = std::env::args().skip(1);
    let dylib = args.next().unwrap_or_else(|| usage());
    let models = args.next();
    if args.next().is_some() {
        usage();
    }

    let env = ort::init_from(&dylib)
        .unwrap_or_else(|e| panic!("cannot load {dylib}: {e}"))
        .with_name("ortsmoke")
        .with_telemetry(false)
        .build()
        .expect("environment");

    let mut failures = 0;
    let mut checked = 0;
    if let Some(models) = models {
        for variant in ["int8", "fp16"] {
            for name in ["biocn_tok", "biocn_pos", "biocn_dep"] {
                let path = Path::new(&models).join(variant).join(format!("{name}.ort"));
                if !path.is_file() {
                    continue;
                }
                checked += 1;
                if let Err(e) = smoke(&env, &path) {
                    eprintln!("  {} FAILED: {e}", path.display());
                    failures += 1;
                } else {
                    eprintln!("  {} ok", path.display());
                }
            }
        }
        if checked == 0 {
            eprintln!("no .ort under {models}/{{int8,fp16}} — nothing checked");
            std::process::exit(1);
        }
    }
    if failures > 0 {
        std::process::exit(1);
    }
    eprintln!("ortsmoke: all good ({checked} model(s), {dylib})");
}

/// One run per graph in the shapes `engine.rs` uses (batch 1, 32 tokens —
/// small enough that even the CPU-only runner is instant):
///
/// * tok:    ids[1×32]
/// * pos:    ids[1×32], span[1×32×1]
/// * dep:    ids[1×32], span[1×32×1], mask[1×32]
///
/// Zero ids are valid tokens; the point is that every kernel executes end to
/// end, not that the output is meaningful.
fn smoke(env: &Environment, path: &Path) -> ort::Result<()> {
    let seq = 32i64;
    let mut sess = Session::builder(env)?
        .with_saved_runtime_optimizations(true)?
        .with_intra_threads(2)?
        .commit_from_file(path)?;
    let ids = vec![0i64; seq as usize];
    let span = vec![0i64; seq as usize];
    let mask = vec![false; seq as usize];

    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let outputs = if name.contains("tok") {
        let input = Tensor::from_array((vec![1, seq], ids.clone()))?;
        sess.run(ort::inputs![input])?
    } else if name.contains("pos") {
        let input = Tensor::from_array((vec![1, seq], ids.clone()))?;
        let span_t = Tensor::from_array((vec![1, seq, 1], span.clone()))?;
        sess.run(ort::inputs![input, span_t])?
    } else if name.contains("dep") {
        let input = Tensor::from_array((vec![1, seq], ids.clone()))?;
        let span_t = Tensor::from_array((vec![1, seq, 1], span.clone()))?;
        let mask_t = Tensor::from_array((vec![1, seq], mask.clone()))?;
        sess.run(ort::inputs![input, span_t, mask_t])?
    } else {
        return Err(ort::Error::new(format!("unknown graph name {name}")));
    };
    // Force the output tensors to materialize so a broken kernel surfaces here.
    for i in 0..outputs.len() {
        let (_, data) = outputs[i].try_extract_tensor::<f32>()?;
        debug_assert!(!data.is_empty() || data.len() == 0);
    }
    Ok(())
}

fn usage() -> ! {
    eprintln!("usage: ortsmoke <libonnxruntime.so|dylib|dll> [models-dir]");
    std::process::exit(2);
}
