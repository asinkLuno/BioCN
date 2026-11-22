//! Exporting a colored book as a new EPUB.
//!
//! The book that leaves this module is the book that came in, with one change:
//! the 主谓宾 words of every colored chapter are wrapped in
//! `<span class="svo svo-…">`. Nothing is rebuilt — the original package
//! document, layout, images, fonts and styles are carried through untouched —
//! because a reader who colors a book wants *that* book, not our idea of one.
//!
//! Two pieces do the work:
//!
//! * [`colorize`] splices spans into the chapter's own XHTML, using the byte
//!   offsets [`crate::reader`] recorded while parsing it. Searching the markup
//!   for the sentence text instead would be a guess: the analyzed text is
//!   whitespace-collapsed and entity-decoded, so it is not a substring of the
//!   document.
//! * [`inject_stylesheet`] adds the CSS that gives those classes their colors,
//!   either as a `<style>` element in each chapter (inline) or as one resource
//!   the chapters link to (external).

use std::io::Write;
use std::ops::Range;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::{FsExt, OpenOptions};

use crate::analysis::Role;
use crate::analyzer::{ColoredParagraph, ColoredSentence};
use crate::library::{file_path, Library};
use crate::reader::{self, Paragraph, Placed};

/// Where a chapter's colors come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stylesheet {
    /// A `<style>` element in every chapter: one file, nothing to lose.
    Inline,
    /// One `biocn.css` resource that the chapters link to: the styles can be
    /// edited after the fact, and are stored once instead of per chapter.
    External,
}

/// How the export went, for a message that can say what actually happened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    /// Chapters whose spans were written, and chapters in the book.
    pub colored: usize,
    pub chapters: usize,
    /// Chapters that had no analysis yet and were copied unchanged.
    pub skipped: usize,
}

/// The 主谓宾 colors, copied from `src/index.css`.
///
/// Duplicated rather than shared because the two live in different worlds: the
/// app reads daisyUI's theme tokens, an exported book has to work in whatever
/// reader the file ends up in, where `prefers-color-scheme` is the only signal
/// available. Changing one without the other is a mismatch, not a build error,
/// which is why this note exists.
pub const STYLESHEET: &str = "\
.svo-subject { color: #c04e08; }
.svo-predicate { color: #137a5b; }
.svo-object { color: #635ba6; }

@media (prefers-color-scheme: dark) {
  .svo-subject { color: #ea9558; }
  .svo-predicate { color: #58c4a3; }
  .svo-object { color: #aba0eb; }
}
";

/// The `<style>` element for inline exports.
pub fn style_element() -> String {
    format!("<style type=\"text/css\">\n{STYLESHEET}</style>")
}

/// The `<link>` element for an external stylesheet at `href`.
pub fn link_element(href: &str) -> String {
    format!("<link rel=\"stylesheet\" type=\"text/css\" href=\"{href}\"/>")
}

/// Wraps every colored span of `paragraphs` in its `<span>`.
///
/// `paragraphs` must be the parse of `html` and `colored` must line up with it
/// one for one — which is how the reader and the whole-book job produce them.
/// A length mismatch means the chapter changed between parsing and coloring, so
/// the chapter is returned uncolored rather than spliced at the wrong place.
pub fn colorize(html: &str, paragraphs: &[Paragraph], colored: &[ColoredParagraph]) -> String {
    if paragraphs.len() != colored.len() {
        return html.to_owned();
    }
    let mut edits: Vec<Edit> = Vec::new();
    for (paragraph, answer) in paragraphs.iter().zip(colored) {
        edits.extend(span_edits(paragraph, answer));
    }
    if edits.is_empty() {
        return html.to_owned();
    }
    edits.sort_by_key(|edit| edit.from);

    let mut out = String::with_capacity(html.len() + edits.len() * 40);
    let mut at = 0usize;
    for edit in edits {
        // A span that does not move forward would splice the document into
        // itself; the only way to get one is a source map that disagrees with
        // the markup, so the fragment is dropped instead.
        if edit.from < at || edit.to > html.len() || edit.from >= edit.to {
            continue;
        }
        out.push_str(&html[at..edit.from]);
        out.push_str("<span class=\"svo svo-");
        out.push_str(edit.role);
        out.push_str("\">");
        out.push_str(&html[edit.from..edit.to]);
        out.push_str("</span>");
        at = edit.to;
    }
    out.push_str(&html[at..]);
    out
}

/// A replacement slice in the source chapter document.
struct Splice {
    from: usize,
    to: usize,
    replacement: String,
}

/// Contiguous non-synthetic source byte ranges for one paragraph.
///
/// Each run lies inside a single text node (never spanning an inline tag), so
/// wrapping a run in `<span data-br="p-r">` is always well-formed HTML.
fn paragraph_runs(paragraph: &Paragraph) -> Vec<Range<usize>> {
    let mut runs: Vec<Range<usize>> = Vec::new();
    let mut current: Option<Range<usize>> = None;
    for (index, placed) in paragraph.source.iter().enumerate() {
        if placed.is_synthetic() || borrows(&paragraph.source, index) {
            if let Some(run) = current.take() {
                runs.push(run);
            }
            continue;
        }
        let from = placed.from as usize;
        let to = placed.to as usize;
        if from >= to {
            continue;
        }
        match &mut current {
            Some(run) if run.end == from => run.end = to,
            _ => {
                if let Some(run) = current.take() {
                    runs.push(run);
                }
                current = Some(from..to);
            }
        }
    }
    if let Some(run) = current {
        runs.push(run);
    }
    runs
}

/// Renders one run (`html[run]`) with any matching `span_edits` spliced in.
fn render_run_with_edits(html: &str, run: &Range<usize>, edits: &[Edit]) -> String {
    let mut out = String::with_capacity(run.len() + 32);
    let mut at = run.start;
    for edit in edits {
        if edit.from < run.start || edit.to > run.end || edit.from < at || edit.from >= edit.to {
            continue;
        }
        out.push_str(&html[at..edit.from]);
        out.push_str("<span class=\"svo svo-");
        out.push_str(edit.role);
        out.push_str("\">");
        out.push_str(&html[edit.from..edit.to]);
        out.push_str("</span>");
        at = edit.to;
    }
    out.push_str(&html[at..run.end]);
    out
}

/// Prepares a chapter document for the live reader:
///
/// * Injects a zero-width `<span data-bp="{p}"></span>` anchor at the start of
///   every paragraph so reading progress can track the exact visible paragraph
///   across font-size / layout / mode changes.
/// * For paragraphs whose analysis is already complete (`complete[p] == true`),
///   splices `<span class="svo svo-*">` directly with zero extra wrappers.
/// * For paragraphs still awaiting background analysis (`complete[p] == false`),
///   wraps each text run in `<span data-br="{p}-{r}">…</span>` (preserving any
///   already-cached spans inside it) so progressive patches can swap them in
///   place without reloading the page.
pub fn colorize_for_reader(
    html: &str,
    paragraphs: &[Paragraph],
    colored: &[ColoredParagraph],
    complete: &[bool],
) -> String {
    if paragraphs.len() != colored.len() || paragraphs.len() != complete.len() {
        return html.to_owned();
    }
    let mut splices: Vec<Splice> = Vec::new();
    for (p_index, ((paragraph, answer), &is_complete)) in paragraphs
        .iter()
        .zip(colored)
        .zip(complete)
        .enumerate()
    {
        let runs = paragraph_runs(paragraph);
        if runs.is_empty() {
            continue;
        }
        let edits = span_edits(paragraph, answer);
        let anchor_at = runs[0].start;
        if is_complete {
            // Insert paragraph anchor at first run start, and standard svo spans.
            splices.push(Splice {
                from: anchor_at,
                to: anchor_at,
                replacement: format!("<span data-bp=\"{p_index}\"></span>"),
            });
            for edit in edits {
                if edit.to <= html.len() && edit.from < edit.to {
                    splices.push(Splice {
                        from: edit.from,
                        to: edit.to,
                        replacement: format!(
                            "<span class=\"svo svo-{}\">{}</span>",
                            edit.role,
                            &html[edit.from..edit.to]
                        ),
                    });
                }
            }
        } else {
            for (r_index, run) in runs.iter().enumerate() {
                if run.end > html.len() {
                    continue;
                }
                let inner = render_run_with_edits(html, run, &edits);
                let mut replacement = String::with_capacity(inner.len() + 48);
                if r_index == 0 {
                    replacement.push_str(&format!("<span data-bp=\"{p_index}\"></span>"));
                }
                replacement.push_str(&format!(
                    "<span data-br=\"{p_index}-{r_index}\">{inner}</span>"
                ));
                splices.push(Splice {
                    from: run.start,
                    to: run.end,
                    replacement,
                });
            }
        }
    }

    if splices.is_empty() {
        return html.to_owned();
    }
    // Sort by start offset; zero-width anchors (`from == to`) come before
    // content replacements starting at the same byte.
    splices.sort_by_key(|s| (s.from, s.to));

    let mut out = String::with_capacity(html.len() + splices.len() * 48);
    let mut at = 0usize;
    for splice in splices {
        if splice.from < at || splice.to > html.len() || splice.from > splice.to {
            continue;
        }
        out.push_str(&html[at..splice.from]);
        out.push_str(&splice.replacement);
        at = splice.to;
    }
    out.push_str(&html[at..]);
    out
}

/// Computes progressive patch payloads `(key, inner_html)` for every text run
/// of paragraph `p_index` once its sentences have been analyzed.
pub fn colorize_paragraph_runs(
    html: &str,
    paragraph: &Paragraph,
    p_index: usize,
    colored: &ColoredParagraph,
) -> Vec<(String, String)> {
    let runs = paragraph_runs(paragraph);
    if runs.is_empty() {
        return Vec::new();
    }
    let edits = span_edits(paragraph, colored);
    runs.iter()
        .enumerate()
        .filter(|(_, run)| run.end <= html.len())
        .map(|(r_index, run)| {
            let inner = render_run_with_edits(html, run, &edits);
            (format!("{p_index}-{r_index}"), inner)
        })
        .collect()
}

/// One stretch of markup to wrap.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Edit {
    from: usize,
    to: usize,
    role: &'static str,
}

/// The spans of one paragraph, as byte ranges in the chapter document.
fn span_edits(paragraph: &Paragraph, colored: &ColoredParagraph) -> Vec<Edit> {
    let roles = paragraph_roles(paragraph, colored);
    let mut edits = Vec::new();
    let mut current: Option<Edit> = None;

    for (index, placed) in paragraph.source.iter().enumerate() {
        let role = roles.get(index).copied().flatten();
        // Every character a span covers has to be markup of its own: a
        // `<br/>` has none, and a run of whitespace collapsed to one space
        // borrows the bytes of the character after it. Wrapping that space
        // would wrap whatever follows it, which is not what was colored.
        let Some(role) =
            role.filter(|_| !placed.is_synthetic() && !borrows(&paragraph.source, index))
        else {
            edits.extend(current.take());
            continue;
        };
        let role = role.as_str();
        match &mut current {
            // One `<span>` per run: the bytes between two runs are tags, and a
            // span may not close inside an element it opened outside of.
            Some(span) if span.role == role && span.to == placed.from as usize => {
                span.to = placed.to as usize;
            }
            _ => {
                edits.extend(current.take());
                current = Some(Edit {
                    from: placed.from as usize,
                    to: placed.to as usize,
                    role,
                });
            }
        }
    }
    edits.extend(current);
    edits
}

/// Whether `placed` has no bytes of its own, only a neighbour's.
///
/// A paragraph's whitespace is collapsed to one space before analysis, and that
/// space is attributed to the character after it (see `reader::push_paragraph`),
/// so the two share a byte range. The character is still needed for offsets;
/// it just cannot be the thing a `<span>` closes around.
fn borrows(source: &[Placed], index: usize) -> bool {
    let Some(placed) = source.get(index) else {
        return false;
    };
    source
        .get(index + 1)
        .is_some_and(|next| next.from == placed.from && next.to == placed.to)
}

/// The role of each character of `paragraph`, aligned with `paragraph.source`.
///
/// Offsets arrive in UTF-16 code units, the unit a DOM `Range` uses; a `Vec`
/// indexed by characters is what the splice needs, so the two are bridged here
/// and nowhere else.
fn paragraph_roles(paragraph: &Paragraph, colored: &ColoredParagraph) -> Vec<Option<Role>> {
    let mut roles = vec![None; paragraph.source.len()];
    // UTF-16 offset of each character, plus one past the last: a segment's end
    // is an offset like any other, and looking it up must not fall off.
    let mut starts = Vec::with_capacity(paragraph.source.len() + 1);
    let mut at = 0usize;
    for placed in &paragraph.source {
        starts.push(at);
        at += placed.ch.len_utf16();
    }
    starts.push(at);

    for sentence in &colored.sentences {
        for segment in &sentence.segments {
            // `normal` is the absence of a role, not a span: the markup should
            // gain nothing where the analyzer found nothing.
            if segment.role == Role::Normal {
                continue;
            }
            let Some(range) = sentence_range(sentence, segment, &starts) else {
                continue;
            };
            for role in &mut roles[range] {
                *role = Some(segment.role);
            }
        }
    }
    roles
}

/// A segment's characters, as indices into the paragraph's characters.
///
/// Both ends must land on a character boundary: a segment that disagrees with
/// the paragraph it claims to come from is skipped rather than clipped, because
/// half a span would color half a word.
fn sentence_range(
    sentence: &ColoredSentence,
    segment: &crate::analysis::Segment,
    starts: &[usize],
) -> Option<Range<usize>> {
    let from = starts
        .binary_search(&(sentence.start + segment.start))
        .ok()?;
    // The segment's own text decides its width: the analyzer is the authority
    // on what it colored, and a segment that runs to the end of the sentence
    // has no character after it to stop at.
    let end = sentence.start + segment.start + crate::analysis::utf16::utf16_len(&segment.text);
    let to = starts.binary_search(&end).ok()?;
    (from < to).then_some(from..to)
}

/// Inserts `markup` into a chapter's `<head>`.
///
/// The document is spliced, not re-serialized: a chapter carries doctypes,
/// namespace declarations, inline styles and comments that a round trip through
/// a parser would quietly rewrite, and the reader that opens this file next
/// should see the book its author made.
pub fn inject_stylesheet(html: &str, markup: &str) -> String {
    if let Some(at) = find_ci(html, "</head>", 0) {
        return insert_at(html, at, markup);
    }
    // A fragment with no head: inside the body is where browser-invalid but
    // readable markup expects a style, and it is still ahead of the text.
    if let Some(at) = find_ci(html, "<body", 0)
        && let Some(close) = html[at..].find('>')
    {
        return insert_at(html, at + close + 1, markup);
    }
    // No body at all: a style element ahead of the content still applies to it.
    insert_at(html, 0, markup)
}

fn insert_at(html: &str, at: usize, markup: &str) -> String {
    let mut out = String::with_capacity(html.len() + markup.len() + 1);
    out.push_str(&html[..at]);
    // One newline, so the inserted element does not run into the next line of
    // whatever formatting the chapter used.
    out.push('\n');
    out.push_str(markup);
    out.push_str(&html[at..]);
    out
}

/// `to` as a href relative to the directory `from_dir`, both container paths.
///
/// Chapters and the stylesheet share a package directory in practice, so this
/// usually returns a bare file name; the `../` form is what keeps an EPUB 3
/// book whose chapters live in subdirectories working.
pub fn relative_href(from_dir: &str, to: &str) -> String {
    let from: Vec<&str> = from_dir
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let target: Vec<&str> = to.split('/').filter(|part| !part.is_empty()).collect();
    let common = from
        .iter()
        .zip(target.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let mut href = "../".repeat(from.len() - common);
    href.push_str(&target[common..].join("/"));
    href
}

/// Case-insensitive search, because XHTML in the wild is `<HEAD>` often enough.
fn find_ci(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let hay = haystack.as_bytes();
    let needle = needle.as_bytes();
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len())
        .find(|&index| hay[index..index + needle.len()].eq_ignore_ascii_case(needle))
}

/// One chapter, read and parsed, before anything is written back.
struct SourceChapter {
    /// The spine order, which is what the cache keys colored chapters by.
    order: usize,
    id: String,
    /// The chapter's directory, for a relative stylesheet href.
    directory: String,
    html: String,
    paragraphs: Vec<Paragraph>,
}

/// The package directory plus every spine chapter, in reading order.
fn read_chapters(file: &std::path::Path) -> Result<(String, Vec<SourceChapter>), String> {
    let book = rbook::Epub::open(file).map_err(|error| format!("不是 EPUB 文件：{error}"))?;
    let package = book.package();
    let directory = package
        .directory()
        .as_str()
        .trim_end_matches('/')
        .to_owned();
    let directory = if directory.is_empty() {
        "/".to_owned()
    } else {
        directory
    };

    let mut chapters = Vec::new();
    for entry in book.spine().iter() {
        let Some(manifest) = entry.manifest_entry() else {
            continue;
        };
        let bytes = manifest
            .read_bytes()
            .map_err(|error| format!("无法读取第 {} 章：{error}", entry.order()))?;
        // A spine is allowed to hold non-document items — the cover image is
        // the usual one. Rewriting its content as HTML would replace the image
        // with text, so only XHTML is parsed and rewritten; the rest is carried
        // through by `keep_orphans`.
        if !is_document(manifest.media_type(), manifest.href().path().as_str()) {
            continue;
        }
        let html = reader::decode(&bytes);
        // Parse now, not after coloring: the analysis needs the paragraph
        // texts, and the spans need the byte offsets this parse recorded. Both
        // come from the same call or they would describe different documents.
        let paragraphs = reader::paragraphs(&html);
        let href = manifest.href().path().as_str().to_owned();
        chapters.push(SourceChapter {
            order: entry.order(),
            id: manifest.id().to_owned(),
            directory: parent_of(&href),
            html,
            paragraphs,
        });
    }
    Ok((directory, chapters))
}

/// Whether a spine item is a document this module can rewrite.
///
/// The media type is authoritative; the extension is the fallback for a book
/// whose manifest leaves it out (common in EPUB 2 conversions).
fn is_document(media_type: &str, href: &str) -> bool {
    const DOCUMENTS: [&str; 3] = [
        "application/xhtml+xml",
        "text/html",
        "application/x-dtbook+xml",
    ];
    if !media_type.is_empty() && media_type != "application/octet-stream" {
        return DOCUMENTS.contains(&media_type) || media_type.ends_with("+xml");
    }
    let name = href.rsplit('/').next().unwrap_or(href);
    [".xhtml", ".html", ".htm", ".xml"]
        .iter()
        .any(|suffix| name.to_lowercase().ends_with(suffix))
}

/// The directory part of a container path (`/OEBPS/text/c1.xhtml` -> `/OEBPS/text`).
fn parent_of(href: &str) -> String {
    match href.rfind('/') {
        Some(0) => "/".to_owned(),
        Some(at) => href[..at].to_owned(),
        None => "/".to_owned(),
    }
}

/// Writes the colored copy of the book to `path`.
#[tauri::command]
pub async fn export_book<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    path: String,
    stylesheet: Stylesheet,
) -> Result<ExportReport, String> {
    // Same rule as opening the book: a job owns the book it is coloring, and
    // the chapter it is in the middle of would be exported plain while the
    // chapters behind it are colored. The shelf disables the item, but a stale
    // window can still get here.
    if app.state::<crate::analyzer::AnalyzerState>().coloring(&id) {
        return Err("book-coloring: 这本书正在着色全书中，请等它完成".into());
    }

    let library = app.state::<Library>().inner().clone();
    let file = library
        .book_file(&id)
        .ok_or_else(|| "book-missing: 书架里没有这本书".to_string())?;

    let cache = app.state::<crate::cache::AnalysisCache>().inner().clone();
    let weights = crate::cache::weights(&app)?;
    let colored_chapters = {
        let cache = cache.clone();
        let book = id.clone();
        tauri::async_runtime::spawn_blocking(move || cache.colored_chapters(&weights, &book))
            .await
            .map_err(|error| error.to_string())??
    };

    // Read and parse off the IPC thread: a book is tens of megabytes and the
    // parser is not free.
    let read = {
        let file = file.clone();
        tauri::async_runtime::spawn_blocking(move || read_chapters(&file))
            .await
            .map_err(|error| error.to_string())?
    }?;
    let (package_directory, chapters) = read;
    let total = chapters.len();

    let state = app.state::<crate::analyzer::AnalyzerState>();
    let mut colored = 0usize;
    let mut rewritten: Vec<(String, String)> = Vec::with_capacity(total);
    for chapter in chapters {
        let order = chapter.order;
        let html = if colored_chapters.contains(&order) {
            let texts = chapter
                .paragraphs
                .iter()
                .map(|paragraph| paragraph.text.clone())
                .collect();
            // The reader's own entry point, so the file matches what the shelf
            // would show: a fully cached chapter is a query, and the few
            // sentences the model rejected are retried exactly as opening the
            // chapter would retry them.
            let answers = state.colored(&app, id.clone(), order, texts).await?;
            colored += 1;
            colorize(&chapter.html, &chapter.paragraphs, &answers)
        } else {
            chapter.html
        };
        rewritten.push((
            chapter.id,
            style(&html, &chapter.directory, stylesheet, &package_directory),
        ));
    }

    let skipped = total - colored;
    let css = stylesheet_path(&package_directory);
    // Writing the archive is CPU-bound (deflate) and the file may be tens of
    // megabytes, so it goes to the blocking pool like the reading did.
    {
        let app = app.clone();
        let file = file.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let bytes = build_epub(&file, &rewritten, &stylesheet, &css)?;
            save(&app, &path, &bytes)
        })
        .await
        .map_err(|error| error.to_string())??;
    }

    Ok(ExportReport {
        colored,
        chapters: total,
        skipped,
    })
}

/// Marks that a chapter already carries this build's stylesheet.
///
/// A book that was exported once can be imported back and exported again — the
/// shelf is a library, and a colored EPUB is a book like any other. Splicing a
/// second `<style>` (or a second `<link>`) in every chapter would be sloppy and
/// pointless: the colors are already declared.
const ALREADY_STYLED: [&str; 2] = [".svo-subject", "biocn.css"];

/// Adds the colors' stylesheet to a chapter, inline or as a link.
fn style(html: &str, chapter_directory: &str, stylesheet: Stylesheet, css: &str) -> String {
    if ALREADY_STYLED.iter().any(|marker| html.contains(marker)) {
        return html.to_owned();
    }
    match stylesheet {
        Stylesheet::Inline => inject_stylesheet(html, &style_element()),
        Stylesheet::External => {
            inject_stylesheet(html, &link_element(&relative_href(chapter_directory, css)))
        }
    }
}

/// Where an external stylesheet lives, as a container path.
fn stylesheet_path(package_directory: &str) -> String {
    format!("{}/biocn.css", package_directory.trim_end_matches('/'))
}

/// Rewrites the book and returns the new archive's bytes.
fn build_epub(
    source: &std::path::Path,
    chapters: &[(String, String)],
    stylesheet: &Stylesheet,
    css: &str,
) -> Result<Vec<u8>, String> {
    let mut book = rbook::Epub::open(source).map_err(|error| format!("不是 EPUB 文件：{error}"))?;
    {
        let mut manifest = book.manifest_mut();
        for (id, html) in chapters {
            if let Some(mut entry) = manifest.by_id_mut(id) {
                entry.set_content(html.clone());
            }
        }
        if *stylesheet == Stylesheet::External {
            // The href is relative to the package directory, which is where the
            // resource is added: rbook resolves it against that directory.
            let href = css.rsplit('/').next().unwrap_or("biocn.css").to_owned();
            // A book that was exported before — or that happens to carry a file
            // by this name — already has an entry for it, and `push` would add
            // a second one pointing at the same path. rbook then writes the
            // resource twice and the zip refuses the duplicate, failing the
            // whole export. Replacing the existing entry's content keeps one
            // item, and the stylesheet this build emits wins.
            // `iter_mut` hands out one entry at a time, so the search is a
            // plain walk: the read-only `href` is reachable through the view,
            // and the index found here is what `get_mut` re-opens.
            let mut found = None;
            let mut index = 0;
            // Scoped so the borrow the iterator holds ends before `get_mut`.
            for mut iter in [manifest.iter_mut()] {
                while let Some(entry) = iter.next() {
                    // Manifest hrefs are absolute container paths (`/OEBPS/biocn.css`);
                    // the new entry is named relative to the package directory.
                    // Comparing the full paths is what keeps a chapter called
                    // `biocn.css` in some subdirectory from being mistaken for it.
                    if entry.as_view().href().path().as_str() == css {
                        found = Some(index);
                        break;
                    }
                    index += 1;
                }
            }
            match found.and_then(|index| manifest.get_mut(index)) {
                Some(mut entry) => {
                    entry.set_content(STYLESHEET.to_owned());
                }
                None => manifest.push((href.as_str(), STYLESHEET.to_owned())),
            }
        }
    }

    book.write()
        // Everything the manifest does not mention is still part of the book:
        // fonts referenced from CSS, `META-INF` extras, the cover's thumbnails.
        // Dropping them would quietly break the copy.
        .keep_orphans(true)
        // The table of contents already exists and points at these chapters;
        // regenerating it would replace a hand-made one with a generated list.
        .generate_toc(false)
        .to_vec()
        .map_err(|error| format!("无法生成 EPUB：{error}"))
}

/// Writes `bytes` to `destination`.
fn save<R: Runtime>(app: &AppHandle<R>, destination: &str, bytes: &[u8]) -> Result<(), String> {
    // Through the fs plugin, not `std::fs`: on Android the destination is a
    // `content://` document the OS owns, and only the plugin can write it.
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let mut out = app
        .fs()
        .open(file_path(destination), options)
        .map_err(|error| format!("无法写入 {destination}：{error}"))?;
    out.write_all(bytes)
        .map_err(|error| format!("无法写入 {destination}：{error}"))?;
    out.flush()
        .map_err(|error| format!("无法写入 {destination}：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::Segment;

    fn subject(text: &str, start: usize) -> Segment {
        Segment {
            text: text.to_owned(),
            start,
            role: Role::Subject,
        }
    }

    #[test]
    fn wraps_the_markup_of_a_colored_sentence() {
        let html = "<html><head></head><body><p>我喜欢猫。</p></body></html>";
        let paragraphs = reader::paragraphs(html);
        let colored = ColoredParagraph {
            text: "我喜欢猫。".to_owned(),
            sentences: vec![ColoredSentence {
                text: "我喜欢猫。".to_owned(),
                start: 0,
                segments: vec![subject("我", 0)],
            }],
        };
        let out = colorize(html, &paragraphs, std::slice::from_ref(&colored));
        assert!(out.contains("我</span>喜欢猫。"), "{out}");
        assert!(out.contains("<span class=\"svo svo-subject\">我"), "{out}");
        // The rest of the document is untouched.
        assert!(out.starts_with("<html><head></head><body>"));
        assert!(out.ends_with("</body></html>"));
    }

    #[test]
    fn a_span_across_inline_markup_does_not_swallow_the_tag() {
        // The subject is split by `<em>`; each piece must close inside its own
        // run, or the document would end up with `<span><em>走</span></em>`.
        let html = "<body><p>他<em>走</em>了。</p></body>";
        let paragraphs = reader::paragraphs(html);
        let colored = ColoredParagraph {
            text: "他走了。".to_owned(),
            sentences: vec![ColoredSentence {
                text: "他走了。".to_owned(),
                start: 0,
                segments: vec![subject("他走", 0)],
            }],
        };
        let out = colorize(html, &paragraphs, std::slice::from_ref(&colored));
        assert_eq!(
            out,
            "<body><p><span class=\"svo svo-subject\">他</span><em><span class=\"svo svo-subject\">走</span></em>了。</p></body>"
        );
    }

    #[test]
    fn a_normal_segment_gains_no_markup() {
        let html = "<body><p>我喜欢猫。</p></body>";
        let paragraphs = reader::paragraphs(html);
        let colored = ColoredParagraph {
            text: "我喜欢猫。".to_owned(),
            sentences: vec![ColoredSentence {
                text: "我喜欢猫。".to_owned(),
                start: 0,
                segments: vec![Segment {
                    text: "我".to_owned(),
                    start: 0,
                    role: Role::Normal,
                }],
            }],
        };
        assert_eq!(colorize(html, &paragraphs, &[colored]), html);
    }

    #[test]
    fn a_paragraph_that_disagrees_with_the_analysis_is_left_alone() {
        let html = "<body><p>一。</p><p>二。</p></body>";
        let paragraphs = reader::paragraphs(html);
        // One paragraph of answers for a two-paragraph chapter: splicing them
        // would put the spans of the first paragraph into the second.
        let colored = vec![ColoredParagraph {
            text: "一。".to_owned(),
            sentences: vec![],
        }];
        assert_eq!(colorize(html, &paragraphs, &colored), html);
    }

    #[test]
    fn an_astral_character_keeps_utf16_offsets_aligned() {
        // The emoji is two UTF-16 units: an offset counted in characters would
        // land one character short.
        let html = "<body><p>𝄞我喜欢猫。</p></body>";
        let paragraphs = reader::paragraphs(html);
        let colored = ColoredParagraph {
            text: "𝄞我喜欢猫。".to_owned(),
            sentences: vec![ColoredSentence {
                text: "𝄞我喜欢猫。".to_owned(),
                start: 0,
                segments: vec![subject("我", 2)],
            }],
        };
        let out = colorize(html, &paragraphs, std::slice::from_ref(&colored));
        assert!(out.contains(">我</span>喜欢猫。"), "{out}");
    }

    #[test]
    fn styles_the_head_and_falls_back_to_the_body() {
        let html = "<html><head><title>t</title></head><body><p>字。</p></body></html>";
        assert_eq!(
            inject_stylesheet(html, "<style>x</style>"),
            "<html><head><title>t</title>\n<style>x</style></head><body><p>字。</p></body></html>"
        );

        // No head: the style goes in at the top of the body, still ahead of the
        // text it applies to.
        let fragment = "<body><p>字。</p></body>";
        assert_eq!(
            inject_stylesheet(fragment, "<style>x</style>"),
            "<body>\n<style>x</style><p>字。</p></body>"
        );

        // No body either: ahead of everything.
        assert_eq!(
            inject_stylesheet("<p>字。</p>", "<style>x</style>"),
            "\n<style>x</style><p>字。</p>"
        );
    }

    /// A one-chapter EPUB on disk, as a reader would find it.
    fn epub_with_chapter(dir: &std::path::Path, html: &str) -> std::path::PathBuf {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let path = dir.join("book.epub");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = SimpleFileOptions::default();
        writer.start_file("mimetype", options).unwrap();
        writer.write_all(b"application/epub+zip").unwrap();
        writer
            .start_file("META-INF/container.xml", options)
            .unwrap();
        writer
            .write_all(
                br#"<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
            )
            .unwrap();
        writer.start_file("OEBPS/content.opf", options).unwrap();
        writer
            .write_all(
                br#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
                     <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                       <dc:title>Test</dc:title>
                     </metadata>
                     <manifest>
                       <item id="chapter1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
                     </manifest>
                     <spine><itemref idref="chapter1"/></spine>
                   </package>"#,
            )
            .unwrap();
        writer
            .start_file("OEBPS/text/chapter1.xhtml", options)
            .unwrap();
        writer.write_all(html.as_bytes()).unwrap();
        writer.finish().unwrap();
        path
    }

    fn read_from(path: &std::path::Path, name: &str) -> Option<String> {
        use std::io::Read as _;

        let file = std::fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut out = String::new();
        archive.by_name(name).ok()?.read_to_string(&mut out).ok()?;
        Some(out)
    }

    /// The whole export, on a real archive: read, splice, write, read back.
    #[test]
    fn an_export_rewrites_the_chapter_and_keeps_the_rest_of_the_book() {
        use std::io::Read as _;

        let dir = tempfile::tempdir().unwrap();
        let source = epub_with_chapter(
            dir.path(),
            "<html><head><title>一章</title></head><body><p>我喜欢猫。</p></body></html>",
        );
        let (package_directory, chapters) = read_chapters(&source).unwrap();
        assert_eq!(package_directory, "/OEBPS");
        assert_eq!(chapters.len(), 1);

        let chapter = &chapters[0];
        let index = chapter
            .paragraphs
            .iter()
            .position(|paragraph| paragraph.text == "我喜欢猫。")
            .unwrap();
        let mut answers: Vec<ColoredParagraph> = chapter
            .paragraphs
            .iter()
            .map(|paragraph| ColoredParagraph {
                text: paragraph.text.clone(),
                sentences: Vec::new(),
            })
            .collect();
        answers[index] = ColoredParagraph {
            text: "我喜欢猫。".to_owned(),
            sentences: vec![ColoredSentence {
                text: "我喜欢猫。".to_owned(),
                start: 0,
                segments: vec![subject("我", 0)],
            }],
        };

        let html = colorize(&chapter.html, &chapter.paragraphs, &answers);
        let css = stylesheet_path(&package_directory);
        assert_eq!(css, "/OEBPS/biocn.css");
        let html = style(&html, &chapter.directory, Stylesheet::External, &css);
        let bytes = build_epub(
            &source,
            &[(chapter.id.clone(), html)],
            &Stylesheet::External,
            &css,
        )
        .unwrap();

        let out = dir.path().join("out.epub");
        std::fs::write(&out, &bytes).unwrap();

        let written = read_from(&out, "OEBPS/text/chapter1.xhtml").unwrap();
        assert!(
            written.contains("<span class=\"svo svo-subject\">我</span>喜欢猫。"),
            "{written}"
        );
        // The stylesheet is one resource, linked from the chapter. A chapter in
        // `text/` reaches the package directory with `../`.
        assert!(
            written.contains("<link rel=\"stylesheet\" type=\"text/css\" href=\"../biocn.css\"/>")
        );
        let sheet = read_from(&out, "OEBPS/biocn.css").unwrap();
        assert!(sheet.contains(".svo-subject"), "{sheet}");
        // And the package document declares it: a reader ignores a resource it
        // is not told about, and the link alone is not an EPUB statement.
        let opf = read_from(&out, "OEBPS/content.opf").unwrap();
        assert!(
            opf.contains(r#"href="biocn.css""#) && opf.contains(r#"media-type="text/css""#),
            "{opf}"
        );
        // And the rest of the book is still there.
        let file = std::fs::File::open(&out).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut mimetype = String::new();
        archive
            .by_name("mimetype")
            .unwrap()
            .read_to_string(&mut mimetype)
            .unwrap();
        assert_eq!(mimetype, "application/epub+zip");
        assert!(archive.by_name("META-INF/container.xml").is_ok());
    }

    #[test]
    fn an_inline_export_embeds_the_styles_in_each_chapter() {
        let html = "<html><head><title>一章</title></head><body><p>字。</p></body></html>";
        let out = style(html, "/OEBPS/text", Stylesheet::Inline, "/OEBPS/biocn.css");
        assert!(out.contains(".svo-subject { color: #c04e08; }"), "{out}");
        assert!(!out.contains("<link"), "{out}");
    }

    #[test]
    fn a_segment_ending_in_space_does_not_wrap_the_next_character() {
        // The analyzer's segment covers "AB " — but the paragraph's space is a
        // collapse that borrows `C`'s bytes. Wrapping it would color `C` and
        // leave `C` itself plain, which is exactly backwards.
        let html = "<body><p>AB CD</p></body>";
        let paragraphs = reader::paragraphs(html);
        let colored = ColoredParagraph {
            text: "AB CD".to_owned(),
            sentences: vec![ColoredSentence {
                text: "AB CD".to_owned(),
                start: 0,
                segments: vec![Segment {
                    text: "AB ".to_owned(),
                    start: 0,
                    role: Role::Subject,
                }],
            }],
        };
        let out = colorize(html, &paragraphs, &[colored]);
        assert_eq!(
            out,
            "<body><p><span class=\"svo svo-subject\">AB</span> CD</p></body>"
        );
    }

    #[test]
    fn a_cdata_section_is_never_spliced_into() {
        // Anything written between `<![CDATA[` and `]]>` is literal text, so a
        // span there would be visible markup. The text keeps its place in the
        // paragraph — it still has to line up with the analysis — but the
        // exporter leaves it alone.
        let html = "<body><p>一<![CDATA[二三]]>四。</p></body>";
        let paragraphs = reader::paragraphs(html);
        let colored = ColoredParagraph {
            text: "一二三四。".to_owned(),
            sentences: vec![ColoredSentence {
                text: "一二三四。".to_owned(),
                start: 0,
                segments: vec![Segment {
                    text: "二三".to_owned(),
                    start: 1,
                    role: Role::Subject,
                }],
            }],
        };
        assert_eq!(colorize(html, &paragraphs, &[colored]), html);
    }

    #[test]
    fn exporting_an_exported_chapter_does_not_add_a_second_stylesheet() {
        let inline = style(
            "<html><head></head><body><p>字。</p></body></html>",
            "/OEBPS",
            Stylesheet::Inline,
            "/OEBPS/biocn.css",
        );
        assert_eq!(
            style(&inline, "/OEBPS", Stylesheet::Inline, "/OEBPS/biocn.css"),
            inline
        );

        // The external form is recognised by its href, whose CSS lives in
        // another file and so is not in the chapter at all.
        let external = style(
            "<html><head></head><body><p>字。</p></body></html>",
            "/OEBPS",
            Stylesheet::External,
            "/OEBPS/biocn.css",
        );
        assert!(external.contains("biocn.css"));
        assert_eq!(
            style(
                &external,
                "/OEBPS",
                Stylesheet::External,
                "/OEBPS/biocn.css"
            ),
            external
        );
    }

    /// One EPUB on disk: a package at `package_dir`, one chapter, plus any
    /// extra manifest items and archive files the test needs.
    fn epub_with(
        dir: &std::path::Path,
        manifest: &str,
        spine: &str,
        files: &[(&str, &[u8])],
    ) -> std::path::PathBuf {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let path = dir.join("book.epub");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = SimpleFileOptions::default();
        writer.start_file("mimetype", options).unwrap();
        writer.write_all(b"application/epub+zip").unwrap();
        writer
            .start_file("META-INF/container.xml", options)
            .unwrap();
        writer
            .write_all(
                br#"<container><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
            )
            .unwrap();
        writer.start_file("content.opf", options).unwrap();
        writer
            .write_all(
                format!(
                    r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
                         <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                           <dc:title>Test</dc:title>
                         </metadata>
                         <manifest>{manifest}</manifest>
                         <spine>{spine}</spine>
                       </package>"#
                )
                .as_bytes(),
            )
            .unwrap();
        for (name, bytes) in files {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        path
    }

    fn chapter_manifest() -> &'static str {
        r#"<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>"#
    }

    #[test]
    fn reader_keeps_manifest_identity_after_a_dangling_spine_item() {
        let dir = tempfile::tempdir().unwrap();
        let source = epub_with(
            dir.path(),
            chapter_manifest(),
            r#"<itemref idref="missing"/><itemref idref="c1"/>"#,
            &[("c1.xhtml", b"<html><body><p>hi</p></body></html>")],
        );
        let chapters = crate::reader::chapters(std::fs::File::open(source).unwrap()).unwrap();
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].index, 1);
        assert_eq!(chapters[0].manifest_id, "c1");
    }
    #[test]
    fn a_spine_item_that_is_not_a_document_keeps_its_bytes() {
        // The cover image sits in the spine of a great many EPUB 2 books.
        // Rewriting it as a chapter would replace the PNG with text — and the
        // export would look successful while producing a broken cover.
        let dir = tempfile::tempdir().unwrap();
        let png: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
        let source = epub_with(
            dir.path(),
            &format!(
                r#"<item id="cover" href="cover.png" media-type="image/png"/>{0}"#,
                chapter_manifest()
            ),
            r#"<itemref idref="cover"/><itemref idref="c1"/>"#,
            &[
                ("cover.png", png),
                (
                    "c1.xhtml",
                    b"<html><head></head><body><p>hi</p></body></html>",
                ),
            ],
        );

        let (package_directory, chapters) = read_chapters(&source).unwrap();
        assert_eq!(chapters.len(), 1, "only the document is rewritten");
        assert_eq!(chapters[0].id, "c1");

        let chapter = &chapters[0];
        let html = style(
            &chapter.html,
            &chapter.directory,
            Stylesheet::Inline,
            &stylesheet_path(&package_directory),
        );
        let bytes = build_epub(
            &source,
            &[(chapter.id.clone(), html)],
            &Stylesheet::Inline,
            &stylesheet_path(&package_directory),
        )
        .unwrap();

        use std::io::Read as _;
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut cover = Vec::new();
        archive
            .by_name("cover.png")
            .unwrap()
            .read_to_end(&mut cover)
            .unwrap();
        assert_eq!(cover, png);
    }

    #[test]
    fn a_book_that_already_has_a_stylesheet_by_that_name_still_exports() {
        // Two ways to get here: exporting a book that was exported before, and
        // a book that ships a file called `biocn.css`. Both used to add a
        // second manifest item for the same path, and the zip writer refused
        // the duplicate filename — the whole export failed.
        let dir = tempfile::tempdir().unwrap();
        let source = epub_with(
            dir.path(),
            &format!(
                r#"<item id="theme" href="biocn.css" media-type="text/css"/>{0}"#,
                chapter_manifest()
            ),
            r#"<itemref idref="c1"/>"#,
            &[
                ("biocn.css", b"/* someone else's colours */"),
                (
                    "c1.xhtml",
                    b"<html><head></head><body><p>hi</p></body></html>",
                ),
            ],
        );

        let bytes = build_epub(&source, &[], &Stylesheet::External, "/biocn.css").unwrap();
        use std::io::Read as _;
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();

        let mut css = String::new();
        archive
            .by_name("biocn.css")
            .unwrap()
            .read_to_string(&mut css)
            .unwrap();
        // Ours wins: a stale copy from an older export would paint the wrong
        // colors, which is worse than no stylesheet at all.
        assert!(css.contains(".svo-subject"), "{css}");

        let mut opf = String::new();
        archive
            .by_name("content.opf")
            .unwrap()
            .read_to_string(&mut opf)
            .unwrap();
        assert_eq!(
            opf.matches(r#"href="biocn.css""#).count(),
            1,
            "one manifest item, not two: {opf}"
        );
    }

    #[test]
    fn a_chapter_sharing_the_stylesheet_name_is_not_mistaken_for_it() {
        // `text/biocn.css` is a different file from `biocn.css` in the package
        // directory. Matching on the bare name would rewrite the chapter.
        let dir = tempfile::tempdir().unwrap();
        let source = epub_with(
            dir.path(),
            r#"<item id="c1" href="text/biocn.css" media-type="application/xhtml+xml"/>"#,
            r#"<itemref idref="c1"/>"#,
            &[(
                "text/biocn.css",
                b"<html><head></head><body><p>hi</p></body></html>",
            )],
        );

        let bytes = build_epub(&source, &[], &Stylesheet::External, "/biocn.css").unwrap();
        use std::io::Read as _;
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();

        let mut chapter = String::new();
        archive
            .by_name("text/biocn.css")
            .unwrap()
            .read_to_string(&mut chapter)
            .unwrap();
        assert!(chapter.contains("<p>hi</p>"), "{chapter}");
        // And the stylesheet itself was added alongside it.
        assert!(archive.by_name("biocn.css").is_ok());
    }

    #[test]
    fn a_chapter_is_recognised_by_media_type_or_extension() {
        assert!(is_document("application/xhtml+xml", "text/c1.xhtml"));
        assert!(is_document("application/x-dtbook+xml", "c1.xml"));
        // No media type: the extension decides.
        assert!(is_document("", "c1.html"));
        assert!(is_document("application/octet-stream", "text/c1.XHTML"));
        assert!(!is_document("image/png", "cover.png"));
        assert!(!is_document("", "cover.png"));
        assert!(!is_document("text/css", "style.css"));
    }

    #[test]
    fn a_stylesheet_href_is_relative_to_the_chapter() {
        assert_eq!(
            relative_href("/OEBPS/text", "/OEBPS/biocn.css"),
            "../biocn.css"
        );
        assert_eq!(relative_href("/OEBPS", "/OEBPS/biocn.css"), "biocn.css");
        assert_eq!(relative_href("/", "/biocn.css"), "biocn.css");
        assert_eq!(
            relative_href("/OEBPS/text/part1", "/OEBPS/biocn.css"),
            "../../biocn.css"
        );
    }

    #[test]
    fn colorize_for_reader_marks_incomplete_runs_and_patches_match_inline_markup() {
        let html = "<body><p>他<em>走</em>了。</p><p>天黑了。</p></body>";
        let paragraphs = reader::paragraphs(html);
        let initial = vec![
            ColoredParagraph {
                text: "他走了。".into(),
                sentences: vec![],
            },
            ColoredParagraph {
                text: "天黑了。".into(),
                sentences: vec![ColoredSentence {
                    text: "天黑了。".into(),
                    start: 0,
                    segments: vec![subject("天", 0)],
                }],
            },
        ];
        // Paragraph 0 is still awaiting analysis; paragraph 1 is already complete.
        let rendered = colorize_for_reader(html, &paragraphs, &initial, &[false, true]);
        assert!(rendered.contains(r#"<span data-bp="0"></span>"#), "{rendered}");
        assert!(rendered.contains(r#"<span data-br="0-0">他</span>"#), "{rendered}");
        assert!(rendered.contains(r#"<em><span data-br="0-1">走</span></em>"#), "{rendered}");
        assert!(rendered.contains(r#"<span data-br="0-2">了。</span>"#), "{rendered}");
        assert!(
            rendered.contains(r#"<span data-bp="1"></span><span class="svo svo-subject">天</span>黑了。"#),
            "{rendered}"
        );
        assert!(!rendered.contains(r#"data-br="1-"#), "{rendered}");

        // Now paragraph 0 completes: its run patches line up with 0-0, 0-1, 0-2.
        let finished_p0 = ColoredParagraph {
            text: "他走了。".into(),
            sentences: vec![ColoredSentence {
                text: "他走了。".into(),
                start: 0,
                segments: vec![
                    subject("他", 0),
                    Segment {
                        text: "走".into(),
                        start: 1,
                        role: Role::Predicate,
                    },
                ],
            }],
        };
        let patches = colorize_paragraph_runs(html, &paragraphs[0], 0, &finished_p0);
        assert_eq!(
            patches,
            vec![
                ("0-0".into(), r#"<span class="svo svo-subject">他</span>"#.into()),
                ("0-1".into(), r#"<span class="svo svo-predicate">走</span>"#.into()),
                ("0-2".into(), "了。".into()),
            ]
        );
    }
}
