//! BioCN 主谓宾 analysis: the three HanLP graphs, ported to Rust.
//!
//! This is upstream's `src-tauri/biocn-core`, moved inside the app instead of a
//! workspace member: the pipeline is only ever consumed through the reader, and
//! a separate crate would need its own `Cargo.toml` and its own copy of the
//! `ort` feature flags to stay in sync.
//!
//! Layout, in data-flow order:
//!
//! ```text
//! tokenizer   basic pieces + wordpiece, matching HF BertTokenizer
//! resources   vocab / normalize / label tables, tensor packing
//! utf16       offsets are UTF-16 code units, like the DOM ranges they become
//! pipeline    one sentence: TOK -> POS -> DEP -> roles, with chunking
//! decode      logits -> words / tags / dependency heads
//! eisner      HanLP's Eisner decoder for the DEP head scores
//! roles       主谓宾 spans over the original text
//! engine      the `ort` sessions the pipeline drives
//! ```
//!
//! The pure half (everything but `engine`) has no I/O, so it is tested against
//! recorded tensors with no model on disk.

pub mod decode;
pub mod eisner;
pub mod engine;
pub mod pipeline;
pub mod resources;
pub mod roles;
pub mod tokenizer;
pub mod utf16;

pub use pipeline::{MAX_SUBS, MAX_WORDS, analyze_sentence};
pub use resources::BioCNResources;
pub use roles::{Dep, Role, Segment};
