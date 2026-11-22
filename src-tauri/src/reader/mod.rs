//! Chapter text out of an EPUB, paragraph by paragraph.
//!
//! The reader does not need the whole book at once, but it does need it in
//! spine order and it needs paragraph boundaries, because BioCN analyzes one
//! paragraph at a time: a sentence cannot be coloured without knowing where the
//! sentence is, and a sentence cannot be found without knowing where the
//! paragraph is.
//!
//! Upstream (`src/epub_parser.py`) takes the same view of an EPUB —
//! `p.get_text()` for every non-empty `<p>` — so the paragraph list here is
//! meant to line up with what the web version would have produced for the same
//! file. That is also why inline markup is flattened rather than preserved: the
//! paragraph *text* is what gets analyzed, and the offsets in the result index
//! into that text.
//!
//! Two details are worth knowing:
//!
//! * Offsets from the analyzer are UTF-16 code units, matching the DOM ranges
//!   the reader builds. Everything here is `String` (UTF-8), so callers convert
//!   with [`crate::analysis::utf16`] rather than assuming byte offsets.
//! * A spine document is XHTML, but real books are not always well-formed XML:
//!   they carry HTML entities (`&nbsp;`) or an `<html>` without a namespace.
//!   The parser is therefore lenient about entities and matches tags by local
//!   name, not by namespace URI.

use std::collections::HashMap;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::Serialize;

/// Blocks whose text is not prose and must not reach the analyzer.
///
/// `<rt>` is furigana in ruby annotations and `<script>`/`<style>` are code;
/// putting any of them in a paragraph would produce nonsense sentences and,
/// worse, offsets that do not line up with what the reader displays.
const SKIPPED: &[&str] = &["script", "style", "rt", "rp", "svg", "math"];

/// Elements that are one paragraph on their own.
///
/// Deliberately short: `<li>`/`<td>`/`<blockquote>` usually wrap a `<p>`, so
/// they are containers below and emit nothing of their own when they do.
const PARAGRAPHS: &[&str] = &[
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "dt",
    "dd",
    "td",
    "th",
    "pre",
    "figcaption",
    "caption",
];

/// Elements that group content.
///
/// They exist as frames so their *own* text is not lost — a `<div>` holding
/// loose text between `<br>`s is a real paragraph — while a `<div>` that merely
/// wraps `<p>`s contributes nothing. Books rely on both shapes: one of the
/// sample EPUBs puts an entire chapter inside `<div class="body">`.
const CONTAINERS: &[&str] = &[
    "div",
    "section",
    "article",
    "blockquote",
    "ul",
    "ol",
    "dl",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "figure",
    "header",
    "footer",
    "aside",
    "nav",
    "main",
    "body",
    "html",
];

fn is_frame(name: &str) -> bool {
    PARAGRAPHS.contains(&name) || CONTAINERS.contains(&name)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paragraph {
    /// Text with inline markup flattened and whitespace collapsed.
    pub text: String,
    /// Where each character of `text` came from in the chapter document.
    ///
    /// Always the same length as `text.chars()`. Empty means "nobody recorded
    /// it" — [`paragraphs`] does not fill it, and a paragraph that only a test
    /// constructs has no markup to point at. The exporter needs it because its
    /// whole job is putting spans back into the *right* text node: `text` is
    /// collapsed and entity-decoded, so searching the source for it would find
    /// the first look-alike instead.
    pub source: Vec<Placed>,
}

impl Paragraph {
    /// A paragraph known only by its text (tests, and callers that do not
    /// rewrite markup).
    pub fn text_only(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            source: Vec::new(),
        }
    }
}

/// One character of a paragraph, and the bytes of the document it came from.
///
/// One entry per character rather than one per markup event: a colored span
/// starts and ends *between* characters, and runs would have to be split again
/// at every boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placed {
    pub ch: char,
    /// Byte range of the markup this character came from. [`SYNTHETIC`] in both
    /// ends for a character that is not in the markup at all (the space a
    /// `<br/>` becomes).
    pub from: u32,
    pub to: u32,
}

impl Placed {
    pub(crate) fn synthetic(ch: char) -> Self {
        Self {
            ch,
            from: SYNTHETIC,
            to: SYNTHETIC,
        }
    }

    /// Not in the markup at all, so there are no bytes to wrap in a span.
    pub fn is_synthetic(&self) -> bool {
        self.from == SYNTHETIC
    }
}

/// [`Placed::from`] of a character that is not in the document.
pub const SYNTHETIC: u32 = u32::MAX;

/// One parsed spine chapter, kept whole for as long as the book is open.
///
/// `html` is the decoded source document — the same string `paragraphs` was
/// parsed from, which is what lets the reader splice colored spans into it at
/// the byte offsets the parse recorded (the exporter's `colorize`). Storing it
/// costs the book's text size in memory, no more than the paragraphs already
/// do; re-reading the zip entry per page turn would cost a seek + inflate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chapter {
    /// Index in the spine, which is also the reader's page order.
    pub index: usize,
    pub manifest_id: String,
    /// The chapter's title from the table of contents, when it has one.
    pub title: Option<String>,
    /// Decoded source XHTML; `paragraphs` is the parse of exactly this string.
    pub html: String,
    pub paragraphs: Vec<Paragraph>,
}

/// Why a book could not be read.
#[derive(Debug)]
pub enum Error {
    /// Not a readable EPUB.
    Invalid(String),
    /// A chapter's bytes could not be read or decoded.
    Chapter { index: usize, reason: String },
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Invalid(reason) => write!(f, "不是 EPUB 文件：{reason}"),
            Error::Chapter { index, reason } => {
                write!(f, "无法读取第 {index} 章：{reason}")
            }
        }
    }
}

impl std::error::Error for Error {}

/// One nested entry of the book's table of contents, with its href already
/// resolved to a spine chapter index and optional fragment anchor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TocEntry {
    pub label: String,
    pub chapter_index: Option<usize>,
    pub anchor: Option<String>,
    pub subitems: Vec<TocEntry>,
}

/// Lightweight metadata for one spine item, before its XHTML is read or parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpineEntry {
    /// Original spine order (`entry.order()`), matching `Chapter::index` and cache keys.
    pub index: usize,
    pub manifest_id: String,
    /// Container-relative path without a leading `/` (percent-decoded), e.g. `OEBPS/Text/ch1.xhtml`.
    pub href: String,
    pub title: Option<String>,
}

/// Structural index of an EPUB: spine order, nested TOC, and href lookup.
///
/// Built from the OPF/NCX/NAV alone — no chapter XHTML is unzipped or parsed.
#[derive(Debug, Clone)]
pub struct BookIndex {
    pub spine: Vec<SpineEntry>,
    pub toc: Vec<TocEntry>,
    /// Normalized container path (no leading `/`, percent-decoded) -> spine index.
    pub by_href: HashMap<String, usize>,
}

/// An open EPUB archive plus its structural index, serving chapters and raw
/// resources (images, CSS, fonts) on demand without re-parsing the zip directory.
pub struct BookHandle {
    epub: rbook::Epub,
    pub index: BookIndex,
}

impl BookHandle {
    pub fn open(path: &Path) -> Result<Self, Error> {
        let epub = rbook::Epub::open(path).map_err(|error| Error::Invalid(error.to_string()))?;
        let index = build_index(&epub);
        Ok(Self { epub, index })
    }

    pub fn from_reader<R: std::io::Read + std::io::Seek + Send + Sync + 'static>(
        reader: R,
    ) -> Result<Self, Error> {
        let epub = rbook::Epub::read(reader).map_err(|error| Error::Invalid(error.to_string()))?;
        let index = build_index(&epub);
        Ok(Self { epub, index })
    }

    /// Reads and parses a single chapter on demand by its spine `index`.
    pub fn read_chapter(&self, index: usize) -> Result<Chapter, Error> {
        let entry = self
            .index
            .spine
            .iter()
            .find(|item| item.index == index)
            .ok_or_else(|| Error::Chapter {
                index,
                reason: "章节不存在".into(),
            })?;
        let manifest = self
            .epub
            .manifest()
            .by_id(&entry.manifest_id)
            .ok_or_else(|| Error::Chapter {
                index,
                reason: "清单中缺少该章节".into(),
            })?;
        let bytes = manifest.read_bytes().map_err(|error| Error::Chapter {
            index,
            reason: error.to_string(),
        })?;
        let html = decode(&bytes);
        let paragraphs = paragraphs(&html);
        Ok(Chapter {
            index: entry.index,
            manifest_id: entry.manifest_id.clone(),
            title: entry.title.clone(),
            html,
            paragraphs,
        })
    }

    /// Spine index for a normalized container path (with or without leading `/`).
    pub fn spine_index_for_href(&self, container_path: &str) -> Option<usize> {
        let normalized = normalize_container_path(container_path)?;
        self.index.by_href.get(&normalized).copied()
    }

    /// Reads any resource (image, CSS, font, SVG, etc.) from the EPUB archive,
    /// returning `(bytes, mime_type)`. Also finds orphan files not listed in OPF.
    pub fn read_resource(&self, container_path: &str) -> Result<Option<(Vec<u8>, String)>, Error> {
        let Some(normalized) = normalize_container_path(container_path) else {
            return Ok(None);
        };
        let rooted = format!("/{normalized}");
        if let Some(entry) = self
            .epub
            .manifest()
            .by_href(&rooted)
            .or_else(|| self.epub.manifest().by_href(&normalized))
        {
            let bytes = entry.read_bytes().map_err(|error| Error::Chapter {
                index: 0,
                reason: error.to_string(),
            })?;
            let mime = resolve_mime(entry.media_type(), &normalized);
            return Ok(Some((bytes, mime)));
        }
        // Fallback for orphan assets (fonts/images referenced from CSS but omitted
        // from the manifest, which real EPUBs do frequently).
        match self.epub.read_resource_bytes(rooted.as_str()) {
            Ok(bytes) => {
                let mime = guess_mime(&normalized).to_owned();
                Ok(Some((bytes, mime)))
            }
            Err(_) => Ok(None),
        }
    }
}

fn build_index(book: &rbook::Epub) -> BookIndex {
    let titles = chapter_titles(book);
    let mut spine = Vec::with_capacity(book.spine().len());
    let mut by_href = HashMap::new();
    let mut by_raw_path: HashMap<String, usize> = HashMap::new();

    for entry in book.spine().iter() {
        let index = entry.order();
        let Some(manifest) = entry.manifest_entry() else {
            continue;
        };
        let raw_path = manifest.href().path();
        let decoded = raw_path.decode();
        let normalized = decoded.trim_start_matches('/').to_owned();
        by_raw_path.insert(raw_path.as_str().to_owned(), index);
        by_href.insert(normalized.clone(), index);
        spine.push(SpineEntry {
            index,
            manifest_id: entry.idref().to_owned(),
            href: normalized,
            title: titles.get(&index).cloned(),
        });
    }

    let toc = extract_toc(book, &by_raw_path, &by_href);
    BookIndex {
        spine,
        toc,
        by_href,
    }
}

fn extract_toc(
    book: &rbook::Epub,
    by_raw_path: &HashMap<String, usize>,
    by_href: &HashMap<String, usize>,
) -> Vec<TocEntry> {
    let map_entry = |root: rbook::epub::toc::EpubTocEntry<'_>| -> Vec<TocEntry> {
        root.iter()
            .map(|child| convert_toc_node(child, by_raw_path, by_href))
            .collect()
    };

    if let Some(contents) = book.toc().contents() {
        let items = map_entry(contents);
        if !items.is_empty() {
            return items;
        }
    }
    for root in book.toc() {
        let items = map_entry(root);
        if !items.is_empty() {
            return items;
        }
    }
    Vec::new()
}

fn convert_toc_node(
    node: rbook::epub::toc::EpubTocEntry<'_>,
    by_raw_path: &HashMap<String, usize>,
    by_href: &HashMap<String, usize>,
) -> TocEntry {
    let label = {
        let trimmed = node.label().trim();
        if trimmed.is_empty() {
            "未命名章节".to_owned()
        } else {
            trimmed.to_owned()
        }
    };
    let (chapter_index, anchor) = match node.href() {
        Some(href) => {
            let path = href.path();
            let index = by_raw_path.get(path.as_str()).copied().or_else(|| {
                let decoded = path.decode();
                by_href.get(decoded.trim_start_matches('/')).copied()
            });
            let anchor = href
                .fragment()
                .map(str::trim)
                .filter(|frag| !frag.is_empty())
                .map(str::to_owned);
            (index, anchor)
        }
        None => (None, None),
    };
    let subitems = node
        .iter()
        .map(|child| convert_toc_node(child, by_raw_path, by_href))
        .collect();
    TocEntry {
        label,
        chapter_index,
        anchor,
        subitems,
    }
}

/// Normalizes a container path, resolving `.` and `..` without allowing escape
/// above the container root. Returns `None` if empty or escaping root.
pub fn normalize_container_path(raw: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for segment in raw.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn resolve_mime(declared: &str, path: &str) -> String {
    let declared = declared.trim();
    if !declared.is_empty() && declared != "application/octet-stream" {
        return declared.to_owned();
    }
    guess_mime(path).to_owned()
}

pub fn guess_mime(path: &str) -> &'static str {
    let ext = path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "xhtml" => "application/xhtml+xml",
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "xml" | "ncx" | "opf" => "application/xml",
        _ => "application/octet-stream",
    }
}

/// Every chapter of the book, in spine order.
///
/// `reader` is consumed because [`rbook::Epub`] borrows it for the lifetime of
/// the parsed book; callers pass an open file (`Library::book_file`) or a
/// `Cursor` over bytes.
pub fn chapters<R: std::io::Read + std::io::Seek + Send + Sync + 'static>(
    reader: R,
) -> Result<Vec<Chapter>, Error> {
    let book = rbook::Epub::read(reader).map_err(|error| Error::Invalid(error.to_string()))?;
    let titles = chapter_titles(&book);

    let spine = book.spine();
    let mut out = Vec::with_capacity(spine.len());
    for entry in spine.iter() {
        let index = entry.order();
        let Some(manifest) = entry.manifest_entry() else {
            // A spine entry pointing at a missing manifest item: skip it
            // rather than fail the whole book, since the rest still reads.
            continue;
        };
        let bytes = manifest.read_bytes().map_err(|error| Error::Chapter {
            index,
            reason: error.to_string(),
        })?;
        let html = decode(&bytes);
        let paragraphs = paragraphs(&html);
        out.push(Chapter {
            index,
            manifest_id: entry.idref().to_owned(),
            title: titles.get(&index).cloned(),
            html,
            paragraphs,
        });
    }
    Ok(out)
}

/// Spine index -> chapter title, from the table of contents.
///
/// The TOC links by href and may point into the middle of a document
/// (`chapter.xhtml#s3`), so the fragment is dropped before matching. A book
/// without a TOC simply has no titles.
fn chapter_titles(book: &rbook::Epub) -> HashMap<usize, String> {
    let mut titles = HashMap::new();
    // `Href::path` is the resolved, percent-normalized path with the query and
    // fragment removed, so both sides of the comparison use the same form.
    let mut by_path: HashMap<&str, usize> = HashMap::new();
    for entry in book.spine().iter() {
        if let Some(manifest) = entry.manifest_entry() {
            by_path.insert(manifest.href().path().as_str(), entry.order());
        }
    }
    // `flatten` walks nested TOC entries depth-first, so a parent is seen before
    // its children and `or_insert` keeps the outermost title for a document —
    // which is the chapter heading, not the first section inside it.
    for root in book.toc() {
        for entry in root.flatten() {
            let Some(href) = entry.href() else { continue };
            let Some(index) = by_path.get(href.path().as_str()).copied() else {
                continue;
            };
            let label = entry.label().trim();
            if !label.is_empty() {
                titles.entry(index).or_insert_with(|| label.to_owned());
            }
        }
    }
    titles
}

/// Decodes a chapter declaration's encoding, defaulting to UTF-8.
///
/// XHTML chapters are allowed to be in a legacy encoding (GB2312 shows up in
/// older Chinese books), and the parser cannot be handed bytes in an encoding
/// it was not told about.
pub(crate) fn decode(bytes: &[u8]) -> String {
    let bytes = bytes
        .strip_prefix([0xEF, 0xBB, 0xBF].as_slice())
        .unwrap_or(bytes);
    let Some(label) = declared_encoding(bytes) else {
        return String::from_utf8_lossy(bytes).into_owned();
    };
    let Some(encoding) = encoding_rs::Encoding::for_label(label.as_bytes()) else {
        return String::from_utf8_lossy(bytes).into_owned();
    };
    if encoding == encoding_rs::UTF_8 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let (text, _, _) = encoding.decode(bytes);
    // The bytes are UTF-8 from here on, so a declaration still naming the
    // original encoding is a lie. It matters most on the way out: the exporter
    // writes this string back into the EPUB, and a reader that trusts the
    // declaration would decode UTF-8 as GBK and see mojibake.
    declare_utf8(&text)
}

/// Rewrites the `encoding` of an XML declaration to `utf-8`, if there is one.
fn declare_utf8(html: &str) -> String {
    // The declaration is ASCII and at the very start, so it is found by simple
    // search over the head of the document.
    let head = &html[..html.len().min(256)];
    let Some(start) = head.find("<?xml") else {
        return html.to_owned();
    };
    let Some(end) = head[start..].find("?>") else {
        return html.to_owned();
    };
    let declaration = &head[start..start + end];
    let Some(at) = declaration.find("encoding") else {
        return html.to_owned();
    };
    let rest = &declaration[at + "encoding".len()..];
    let Some(quoted) = rest.find(['"', '\'']) else {
        return html.to_owned();
    };
    let quote = &rest[quoted..quoted + 1];
    let Some(close) = rest[quoted + 1..].find(quote) else {
        return html.to_owned();
    };
    let value = start + at + "encoding".len() + quoted + 1;
    let mut out = String::with_capacity(html.len());
    out.push_str(&html[..value]);
    out.push_str(encoding_rs::UTF_8.name());
    out.push_str(&html[value + close..]);
    out
}

/// The `encoding="…"` value in the XML declaration, if the document has one.
pub(crate) fn declared_encoding(xml: &[u8]) -> Option<String> {
    // The declaration is ASCII and must be the first thing in the document, so
    // it is searched byte-wise: the bytes after it are in whatever encoding the
    // declaration names, which by definition is not UTF-8.
    let head = &xml[..xml.len().min(256)];
    let start = find(head, b"<?xml")?;
    let declaration = &head[start..];
    let end = find(declaration, b"?>")?;
    let declaration = &declaration[..end];
    let at = find(declaration, b"encoding")? + "encoding".len();
    let quote_at =
        at + find(&declaration[at..], b"\"").or_else(|| find(&declaration[at..], b"'"))?;
    let quote = declaration[quote_at];
    let value = &declaration[quote_at + 1..];
    let value_end = find(value, &[quote])?;
    Some(String::from_utf8_lossy(&value[..value_end]).into_owned())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Paragraphs of one chapter document, in reading order.
///
/// The offsets recorded in each [`Paragraph`] are only meaningful for the
/// *same* string that was parsed, and they are the reason the exporter cannot
/// work by "find `text` in `html`": `text` is whitespace-collapsed and
/// entity-decoded, so two paragraphs can collapse to the same string, and a
/// phrase can appear inside another one.
pub fn paragraphs(html: &str) -> Vec<Paragraph> {
    let mut reader = Reader::from_str(html);
    let config = reader.config_mut();
    // Real chapters are XHTML, not well-formed XML: converters leave mismatched
    // end tags behind and hand-write `&nbsp;`, and refusing either would fail a
    // whole book over one bad tag. Text is never trimmed here because a space
    // between two inline elements is a space in the paragraph.
    config.check_end_names = false;
    config.allow_unmatched_ends = true;
    config.allow_dangling_amp = true;

    let mut out: Vec<Paragraph> = Vec::new();
    // Open frames, innermost last. Text lands in the innermost frame, so a
    // `<p>` inside a `<div>` collects its own text and the `<div>` keeps only
    // what sits outside the `<p>`.
    let mut stack: Vec<Frame> = Vec::new();
    // Nesting depth of skipped elements: `> 0` means "do not collect text".
    let mut skipped = 0usize;

    // A malformed tail must not lose the paragraphs read so far, so the loop
    // stops at the first parse error rather than propagating it.
    loop {
        // `buffer_position` before and after the read brackets exactly the bytes
        // this event consumed — a start tag, a text run, or `&amp;` — which is
        // what a rewrite has to replace. It is the one thing quick-xml does not
        // hand back with the event.
        let begin = byte_position(&reader);
        let Ok(event) = reader.read_event() else {
            break;
        };
        let end = byte_position(&reader);
        let span = (begin < end && end <= html.len()).then_some(begin..end);
        match event {
            Event::Start(start) => {
                let name = local_name(start.local_name().as_ref());
                if SKIPPED.contains(&name.as_str()) {
                    skipped += 1;
                } else if is_frame(&name) {
                    // A child block ends the text before it: `<div>见<p>字</p>后</div>`
                    // is "见", "字", "后". The parent frame stays open, so the
                    // text after the child still belongs to it — that is what
                    // keeps the paragraphs in reading order.
                    if let Some(frame) = stack.last_mut() {
                        frame.flush_text(&mut out);
                    }
                    stack.push(Frame::new(name));
                }
            }
            Event::End(end_tag) => {
                let name = local_name(end_tag.local_name().as_ref());
                if SKIPPED.contains(&name.as_str()) {
                    skipped = skipped.saturating_sub(1);
                } else if is_frame(&name) {
                    // Pop down to the matching frame. A stray end tag for a
                    // frame that was never opened (`allow_unmatched_ends`) must
                    // not pop a frame that is still open.
                    if let Some(position) = stack.iter().rposition(|frame| frame.name == name) {
                        while stack.len() > position {
                            close_innermost(&mut stack, &mut out);
                        }
                    }
                }
            }
            Event::Empty(empty) => {
                // `<br/>` ends the current line but not the paragraph; an empty
                // block element (`<p/>`) has no text and so emits nothing.
                let name = local_name(empty.local_name().as_ref());
                if name == "br"
                    && let Some(frame) = stack.last_mut()
                {
                    // A synthesized space: it is in the paragraph text but not
                    // in the markup, so it has no bytes to point at.
                    frame.push_placed(Placed::synthetic(' '));
                }
            }
            Event::Text(text) => {
                // `skipped` guards `<script>`/`<style>`/`<rt>`: their character
                // data is not prose even though it is text.
                if skipped == 0
                    && let Some(frame) = stack.last_mut()
                    && let Some(span) = span
                {
                    // `into_inner` rather than `xml_content`: the offsets are
                    // walked over these bytes, so normalizing `\r\n` here
                    // would shift every character after it. EOL normalization
                    // happens in `push_paragraph`, where the bytes no longer
                    // matter.
                    frame.push_str(&text.into_inner(), span);
                }
            }
            Event::CData(cdata) => {
                if skipped == 0
                    && let Some(frame) = stack.last_mut()
                {
                    // Literal text, so nothing can be spliced into it: a `<span>`
                    // written between `<![CDATA[` and `]]>` would come out as
                    // visible text, not markup. The characters are still part of
                    // the paragraph — they have to be, or the offsets of
                    // everything after them would be wrong — but they are
                    // marked as having no bytes of their own, which is what
                    // tells the exporter to leave them alone.
                    for ch in cdata.into_inner().chars() {
                        frame.push_placed(Placed::synthetic(ch));
                    }
                }
            }
            Event::GeneralRef(reference) => {
                // quick-xml splits `&…;` out of the text, so entities have to be
                // resolved here: numeric refs, XML's five, and the HTML ones a
                // hand-written chapter is likely to contain.
                if skipped == 0
                    && let Some(frame) = stack.last_mut()
                    && let Some(span) = span
                {
                    let name: &str = reference.as_ref();
                    let text = match reference.resolve_char_ref() {
                        Ok(Some(ch)) => ch.to_string(),
                        _ => match entity_text(name) {
                            Some(entity) => entity.to_owned(),
                            None => continue,
                        },
                    };
                    // The whole `&name;` is one span for every character it
                    // resolves to, so replacing any of them replaces the
                    // reference rather than leaving a dangling `&`.
                    frame.push_ref(&text, span);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    // A document that ends in the middle of a paragraph still has that text.
    while !stack.is_empty() {
        close_innermost(&mut stack, &mut out);
    }
    out
}

fn close_innermost(stack: &mut Vec<Frame>, out: &mut Vec<Paragraph>) {
    if let Some(frame) = stack.pop() {
        frame.flush(out);
    }
}

/// One open block element, plus the characters collected directly inside it.
struct Frame {
    name: String,
    /// The characters of the paragraph being collected, in reading order.
    chars: Vec<Placed>,
}

impl Frame {
    fn new(name: String) -> Self {
        Self {
            name,
            chars: Vec::new(),
        }
    }

    fn push_placed(&mut self, placed: Placed) {
        self.chars.push(placed);
    }

    /// Records a markup event's text, remembering where each character sits.
    ///
    /// `text` has to be the source bytes of `span` verbatim — the offsets are
    /// computed by walking it — which is why the parser hands over
    /// [`Event::Text`]'s own content instead of a normalized copy: entity
    /// references are separate events, so a text run is exactly its bytes.
    fn push_str(&mut self, text: &str, span: std::ops::Range<usize>) {
        for (offset, ch) in text.char_indices() {
            let from = byte_in_document(span.start + offset);
            let to = byte_in_document(span.start + offset + ch.len_utf8());
            self.chars.push(Placed { ch, from, to });
        }
    }

    /// Records an entity reference's text.
    ///
    /// Every character it resolves to points at the whole `&name;`, because
    /// that is the unit a rewrite can replace: wrapping part of it would leave
    /// a dangling `&` in the document.
    fn push_ref(&mut self, text: &str, span: std::ops::Range<usize>) {
        let from = byte_in_document(span.start);
        let to = byte_in_document(span.end);
        for ch in text.chars() {
            self.chars.push(Placed { ch, from, to });
        }
    }

    /// Ends the paragraph this frame has collected so far, keeping the frame
    /// open for whatever follows.
    fn flush_text(&mut self, out: &mut Vec<Paragraph>) {
        // A container's own text is a paragraph too (the `<div>` + `<br>` shape).
        // Indentation between nested blocks collapses to nothing and is dropped
        // by `push_paragraph`, so no "did I hold a child block" bookkeeping is
        // needed.
        if self.chars.is_empty() {
            return;
        }
        push_paragraph(std::mem::take(&mut self.chars), out);
    }

    fn flush(mut self, out: &mut Vec<Paragraph>) {
        self.flush_text(out);
    }
}

/// Byte position in the document that the reader will resume from.
///
/// Before a read it is where the next event starts; after one it is just past
/// that event, so bracketing the two gives the event's own bytes.
fn byte_position<R: std::io::BufRead>(reader: &Reader<R>) -> usize {
    usize::try_from(reader.buffer_position()).unwrap_or(usize::MAX)
}

/// A document byte offset as [`Placed`] stores it.
///
/// A chapter larger than 4 GiB cannot be pointed at, and is not worth failing
/// over: it becomes [`SYNTHETIC`], which means "no bytes" and costs a span
/// rather than producing a wrong one.
fn byte_in_document(at: usize) -> u32 {
    u32::try_from(at).unwrap_or(SYNTHETIC)
}

/// Entities that XHTML chapters use and XML does not define.
/// Lowercase tag name (`xhtml:p` -> `p`); quick-xml has already stripped the
/// namespace prefix for us.
fn local_name(name: &str) -> String {
    name.to_ascii_lowercase()
}

/// Text for an entity reference: XML's five first, then the HTML ones prose uses.
fn entity_text(name: &str) -> Option<&'static str> {
    quick_xml::escape::resolve_predefined_entity(name).or_else(|| html_entity(name))
}

/// Collapses one paragraph's characters into its text.
///
/// Runs of whitespace collapse to one space, which is what the analyzer is
/// given; the surviving characters keep the markup bytes they came from, so the
/// exporter can put spans back where they belong. A collapsed space is charged
/// to the *first* character of the run that follows it, because a span boundary
/// must not fall between the space and the word it precedes.
pub fn push_paragraph(chars: Vec<Placed>, out: &mut Vec<Paragraph>) {
    let mut text = String::new();
    let mut kept: Vec<Placed> = Vec::with_capacity(chars.len());
    // Whitespace seen but not yet emitted: one run may end in spaces and the
    // next begin immediately, and the collapse owes exactly one space between
    // them.
    let mut pending_space = false;
    for placed in chars {
        let collapse = placed.ch.is_whitespace() || placed.ch == '\u{a0}';
        if collapse {
            pending_space = true;
            continue;
        }
        if pending_space && !text.is_empty() {
            // The space is not in the source, so it has no bytes of its own; it
            // is attributed to this character's span, keeping the two together.
            text.push(' ');
            kept.push(Placed {
                ch: ' ',
                ..placed.clone()
            });
        }
        pending_space = false;
        text.push(placed.ch);
        kept.push(placed);
    }
    if text.is_empty() {
        return;
    }
    out.push(Paragraph { text, source: kept });
}

/// HTML entities that XHTML chapters use and XML does not define.
///
/// `quick-xml` with the `escape-html` feature knows all 2231 of them, but the
/// crate's own comment warns that the table costs 10+ seconds of compile time,
/// and prose only ever uses these. Adding one here is cheaper than the feature.
fn html_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        // `nbsp` is deliberately absent: it is a space, and a space in a
        // paragraph is collapsed to an ordinary one before analysis.
        "mdash" => "—",
        "ndash" => "–",
        "hellip" => "…",
        "lsquo" => "\u{2018}",
        "rsquo" => "\u{2019}",
        "ldquo" => "\u{201c}",
        "rdquo" => "\u{201d}",
        "middot" => "·",
        "bull" => "•",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "deg" => "°",
        "times" => "×",
        "divide" => "÷",
        "shy" => "",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(html: &str) -> Vec<String> {
        paragraphs(html)
            .into_iter()
            .map(|paragraph| paragraph.text)
            .collect()
    }

    #[test]
    fn takes_one_paragraph_per_block_element() {
        let html = "<html><body><p>第一段。</p><p>第二段。</p></body></html>";
        assert_eq!(texts(html), ["第一段。", "第二段。"]);
    }

    #[test]
    fn flattens_inline_markup_into_the_paragraph() {
        let html = r#"<body><p>他说：<em>走</em>吧<span class="x">。</span></p></body>"#;
        assert_eq!(texts(html), ["他说：走吧。"]);
    }

    #[test]
    fn collapses_source_indentation_but_keeps_spaces_between_words() {
        let html = "<body>\n  <p>\n    第一句。\n    第二句。\n  </p>\n</body>";
        assert_eq!(texts(html), ["第一句。 第二句。"]);
    }

    #[test]
    fn skips_script_style_and_ruby_annotations() {
        let html = r#"<body>
            <style>p { color: red }</style>
            <p>正文。</p>
            <p><ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby></p>
            <script>alert(1)</script>
        </body>"#;
        assert_eq!(texts(html), ["正文。", "漢字"]);
    }

    #[test]
    fn an_empty_or_whitespace_only_paragraph_is_dropped() {
        let html = "<body><p>　</p><p> </p><p>有字。</p></body>";
        assert_eq!(texts(html), ["有字。"]);
    }

    #[test]
    fn a_block_nested_in_a_block_still_ends_the_paragraph_before_it() {
        // Two blocks are two paragraphs even when one is inside the other, and
        // they come out in reading order rather than inner-first.
        let html = "<body><div>第一段<div>内层</div>第三段</div></body>";
        assert_eq!(texts(html), ["第一段", "内层", "第三段"]);
    }

    #[test]
    fn a_wrapper_element_around_paragraphs_adds_no_paragraph_of_its_own() {
        // The shape one of the sample books uses for whole chapters: everything
        // inside a single `<div>`, with the real paragraphs as `<p>` children.
        let html = r#"<body><div class="body"><p>一。</p><p>二。</p><p>三。</p></div></body>"#;
        assert_eq!(texts(html), ["一。", "二。", "三。"]);
    }

    #[test]
    fn a_br_separated_div_is_read_as_one_paragraph() {
        // The other common shape: no `<p>` at all, lines split by `<br/>`.
        let html = "<body><div>第一行<br/>第二行</div></body>";
        assert_eq!(texts(html), ["第一行 第二行"]);
    }

    #[test]
    fn a_list_item_holding_a_paragraph_does_not_duplicate_its_text() {
        let html = "<body><ul><li><p>条目一。</p></li><li>条目二。</li></ul></body>";
        assert_eq!(texts(html), ["条目一。", "条目二。"]);
    }

    #[test]
    fn resolves_html_entities_that_xml_does_not_define() {
        let html = "<body><p>a&mdash;b&hellip;&#65;&#x42;</p></body>";
        assert_eq!(texts(html), ["a—b…AB"]);
    }

    #[test]
    fn a_non_breaking_space_collapses_like_any_other_space() {
        // `&nbsp;` is a space to a reader; leaving U+00A0 in the paragraph would
        // hand the analyzer a character it never sees in the same place twice.
        let html = "<body><p>a&nbsp;b</p></body>";
        assert_eq!(texts(html), ["a b"]);
    }

    #[test]
    fn a_truncated_document_keeps_the_paragraph_it_was_reading() {
        // Malformed input is common; the text collected so far is still text.
        let html = "<body><p>完整。</p><p>被截断";
        assert_eq!(texts(html), ["完整。", "被截断"]);
    }

    #[test]
    fn decodes_a_legacy_declared_encoding() {
        // GBK bytes for 中文, with a declaration that says so.
        let mut bytes = br#"<?xml version="1.0" encoding="gbk"?><body><p>"#.to_vec();
        bytes.extend_from_slice(&[0xD6, 0xD0, 0xCE, 0xC4]);
        bytes.extend_from_slice(b"</p></body>");
        let html = decode(&bytes);
        assert_eq!(texts(&html), ["中文"]);
        // Decoding produces UTF-8, so the declaration must say so: the exporter
        // writes this string back into the EPUB, and a reader that trusted the
        // stale label would show mojibake.
        assert!(
            html.starts_with(r#"<?xml version="1.0" encoding="UTF-8"?>"#),
            "{html}"
        );
    }

    #[test]
    fn leaves_a_utf8_declaration_alone() {
        let html = decode(r#"<?xml version="1.0" encoding="utf-8"?><p>字。</p>"#.as_bytes());
        assert_eq!(html, r#"<?xml version="1.0" encoding="utf-8"?><p>字。</p>"#);
        // A document with no declaration at all is not given one.
        assert_eq!(decode(b"<p>x</p>"), "<p>x</p>");
    }

    #[test]
    fn reads_the_encoding_label_only_from_the_declaration() {
        assert_eq!(
            declared_encoding(br#"<?xml version="1.0" encoding="GB2312"?><html/>"#).as_deref(),
            Some("GB2312")
        );
        assert_eq!(declared_encoding(b"<html/>"), None);
        // A stray `encoding=` inside the body is not a declaration.
        assert_eq!(
            declared_encoding(br#"<html><p>encoding="gbk"</p></html>"#),
            None
        );
    }

    #[test]
    fn a_paragraph_with_only_markup_is_dropped() {
        let html = "<body><p><img src=\"a.png\"/></p><p>字。</p></body>";
        assert_eq!(texts(html), ["字。"]);
    }

    #[test]
    fn normalizes_container_paths_and_rejects_escapes() {
        assert_eq!(
            normalize_container_path("/OEBPS/Text/../Images/a.png").as_deref(),
            Some("OEBPS/Images/a.png")
        );
        assert_eq!(
            normalize_container_path("OEBPS/./ch1.xhtml").as_deref(),
            Some("OEBPS/ch1.xhtml")
        );
        assert_eq!(normalize_container_path("../secret"), None);
        assert_eq!(normalize_container_path("/"), None);
    }

    #[test]
    fn book_handle_extracts_nested_toc_and_reads_chapters_and_resources_on_demand() {
        use std::io::{Cursor, Write as _};
        use zip::write::SimpleFileOptions;

        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        writer
            .start_file("META-INF/container.xml", options)
            .unwrap();
        writer
            .write_all(br#"<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#)
            .unwrap();
        writer.start_file("OEBPS/content.opf", options).unwrap();
        writer
            .write_all(
                br#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
                  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test</dc:title></metadata>
                  <manifest>
                    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
                    <item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml"/>
                    <item id="img" href="Images/p.png" media-type="image/png"/>
                  </manifest>
                  <spine><itemref idref="c1"/></spine>
                </package>"#,
            )
            .unwrap();
        writer.start_file("OEBPS/nav.xhtml", options).unwrap();
        writer
            .write_all(
                r#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
                  <body><nav epub:type="toc"><ol>
                    <li><a href="Text/c1.xhtml">第一章</a>
                      <ol><li><a href="Text/c1.xhtml#s1">第一节</a></li></ol>
                    </li>
                  </ol></nav></body>
                </html>"#
                    .as_bytes(),
            )
            .unwrap();
        writer.start_file("OEBPS/Text/c1.xhtml", options).unwrap();
        writer
            .write_all(b"<html><body><h1 id=\"s1\">Hello</h1><p>\xe4\xbb\x96\xe8\xb5\xb0\xe4\xba\x86\xe3\x80\x82</p></body></html>")
            .unwrap();
        writer.start_file("OEBPS/Images/p.png", options).unwrap();
        writer.write_all(b"PNGDATA").unwrap();
        let bytes = writer.finish().unwrap().into_inner();

        let handle = BookHandle::from_reader(Cursor::new(bytes)).unwrap();
        assert_eq!(handle.index.spine.len(), 1);
        assert_eq!(handle.index.spine[0].href, "OEBPS/Text/c1.xhtml");
        assert_eq!(handle.index.spine[0].title.as_deref(), Some("第一章"));
        assert_eq!(handle.spine_index_for_href("/OEBPS/Text/c1.xhtml"), Some(0));

        assert_eq!(handle.index.toc.len(), 1);
        assert_eq!(handle.index.toc[0].label, "第一章");
        assert_eq!(handle.index.toc[0].chapter_index, Some(0));
        assert_eq!(handle.index.toc[0].anchor, None);
        assert_eq!(handle.index.toc[0].subitems.len(), 1);
        assert_eq!(handle.index.toc[0].subitems[0].label, "第一节");
        assert_eq!(handle.index.toc[0].subitems[0].anchor.as_deref(), Some("s1"));

        let chapter = handle.read_chapter(0).unwrap();
        assert_eq!(chapter.paragraphs.len(), 2);
        assert_eq!(chapter.paragraphs[1].text, "他走了。");

        let (img_bytes, mime) = handle
            .read_resource("OEBPS/Images/p.png")
            .unwrap()
            .expect("image found");
        assert_eq!(img_bytes, b"PNGDATA");
        assert_eq!(mime, "image/png");
    }
}
