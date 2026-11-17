# BioCN

Desktop reader for EPUB books with 主谓宾 (subject–predicate–object) coloring.
A port of [asinkLuno/bioCN](https://github.com/asinkLuno/bioCN) to Tauri 2 +
React 19, running the same analysis fully offline.

## What it does

- **Library.** EPUB files are copied into the app, covers extracted, shelf shown
  as a grid. Nothing is read from the original location afterwards.
- **Reader.** One chapter at a time, with a table of contents and arrow-key
  paging. Text is rendered from the EPUB's own block elements, so paragraphs
  break where the book breaks them.
- **Coloring.** Each sentence is split, tokenized, part-of-speech tagged and
  dependency-parsed by three small ONNX models; subjects, predicates and objects
  get distinct colors. Same colors as the web version.
- **Offline.** The models are downloaded once (67 MB or 78 MB) from ModelScope
  and verified against published sha256 digests. After that the app never
  touches the network.

## Layout

```
src/                    React frontend (daisyUI components only, per AGENTS.md)
  components/           Reader, SettingsSheet, ModelSheet, BookTile
  hooks/                useLibrary, useSettings
  lib/                  typed invoke wrappers, theme, picker
src-tauri/src/
  library/              EPUB import, index, covers, per-book files
  reader/               EPUB -> chapters -> paragraphs (quick-xml)
  text/                 sentence splitting: corrected rules + byte-exact upstream port
  analysis/             tokenizer / POS / dependency ONNX pipeline, EISner decoding
  analyzer.rs           主谓宾 analyzer: session lifecycle, sentence cache
  reading.rs            book_open / book_chapter commands
  models.rs             ModelScope download, resume, sha256 verify, install
  settings.rs           settings.json (atomic writes)
tools/                  Python: export/quantize/convert/publish the models
```

## Development

```sh
yarn install
yarn tauri dev          # desktop
yarn dev                # frontend only, in a browser (no Rust side)

yarn test               # vitest
cargo test --lib        # in src-tauri/
yarn build              # tsc + vite
```

Analysis needs weights. A debug build reads them from `tools/models/<variant>/`
when present (see `tools/README.md`), otherwise download them once from
Settings → Models. `src-tauri/examples/` holds two diagnostic harnesses:

```sh
cargo run --release --example bookdump -- <book.epub>   # paragraph extraction
cargo run --release --example colordump -- <book.epub> <chapter> <paragraphs>
```

## Notes on the sentence splitter

The web version calls `hanlp.utils.rules.split_sentence`, a 12-line regex that
splits after `。！？` but not when the next character is `”’`, and splits `？！`
down the middle. `src-tauri/src/text/upstream.rs` is a byte-exact port of it,
kept for the "match the web version exactly" setting.

The default (`text/corrected.rs`) is a single-pass state machine over the same
rules with two fixes: `」』》〉】〕` count as closing quotes, and a run of terminal
punctuation ends a sentence once. Against the upstream splitter as ground truth
on eight real books (35,181 paragraphs), it agrees on 86–93% of boundaries;
most of the disagreement is where upstream breaks inside a quoted clause.

## License

The models are derived from HanLP, which is Apache-2.0; see `tools/LICENSE`.
