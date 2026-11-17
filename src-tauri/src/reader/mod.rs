//! Chapter text out of an EPUB, paragraph by paragraph.
//!
//! The reader does not need the whole book at once, but it does need it in
//! spine order and it needs paragraph boundaries, because bioCN analyzes one
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

use quick_xml::events::Event;
use quick_xml::reader::Reader;

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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chapter {
    /// Index in the spine, which is also the reader's page order.
    pub index: usize,
    /// The chapter's title from the table of contents, when it has one.
    pub title: Option<String>,
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
            Error::Invalid(reason) => write!(f, "not an EPUB file: {reason}"),
            Error::Chapter { index, reason } => {
                write!(f, "chapter {index} could not be read: {reason}")
            }
        }
    }
}

impl std::error::Error for Error {}

/// Every chapter of the book, in spine order.
///
/// `reader` is consumed because [`rbook::Epub`] borrows it for the lifetime of
/// the parsed book; callers pass an open file (`Library::book_file`) or a
/// `Cursor` over bytes.
pub fn chapters<R: std::io::Read + std::io::Seek + 'static>(
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
        out.push(Chapter {
            index,
            title: titles.get(&index).cloned(),
            paragraphs: paragraphs(&html),
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
fn decode(bytes: &[u8]) -> String {
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
    text.into_owned()
}

/// The `encoding="…"` value in the XML declaration, if the document has one.
fn declared_encoding(xml: &[u8]) -> Option<String> {
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

    let mut out = Vec::new();
    // Open frames, innermost last. Text lands in the innermost frame, so a
    // `<p>` inside a `<div>` collects its own text and the `<div>` keeps only
    // what sits outside the `<p>`.
    let mut stack: Vec<Frame> = Vec::new();
    // Nesting depth of skipped elements: `> 0` means "do not collect text".
    let mut skipped = 0usize;

    // A malformed tail must not lose the paragraphs read so far, so the loop
    // stops at the first parse error rather than propagating it.
    while let Ok(event) = reader.read_event() {
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
            Event::End(end) => {
                let name = local_name(end.local_name().as_ref());
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
                    frame.push(' ');
                }
            }
            Event::Text(text) => {
                // `skipped` guards `<script>`/`<style>`/`<rt>`: their character
                // data is not prose even though it is text.
                if skipped == 0
                    && let Some(frame) = stack.last_mut()
                {
                    frame.push_str(&decode_text(&text));
                }
            }
            Event::CData(text) => {
                if skipped == 0
                    && let Some(frame) = stack.last_mut()
                {
                    frame.push_str(&text.into_inner());
                }
            }
            Event::GeneralRef(reference) => {
                // quick-xml splits `&…;` out of the text, so entities have to be
                // resolved here: numeric refs, XML's five, and the HTML ones a
                // hand-written chapter is likely to contain.
                if skipped == 0
                    && let Some(frame) = stack.last_mut()
                {
                    let name: &str = reference.as_ref();
                    if let Ok(Some(ch)) = reference.resolve_char_ref() {
                        frame.push(ch);
                    } else if let Some(entity) = entity_text(name) {
                        frame.push_str(entity);
                    }
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

/// One open block element, plus the text collected directly inside it.
struct Frame {
    name: String,
    text: String,
}

impl Frame {
    fn new(name: String) -> Self {
        Self {
            name,
            text: String::new(),
        }
    }

    fn push(&mut self, ch: char) {
        self.text.push(ch);
    }

    fn push_str(&mut self, text: &str) {
        self.text.push_str(text);
    }

    /// Ends the paragraph this frame has collected so far, keeping the frame
    /// open for whatever follows.
    fn flush_text(&mut self, out: &mut Vec<Paragraph>) {
        // A container's own text is a paragraph too (the `<div>` + `<br>` shape).
        // Indentation between nested blocks collapses to nothing and is dropped
        // by `push_paragraph`, so no "did I hold a child block" bookkeeping is
        // needed.
        if self.text.is_empty() {
            return;
        }
        push_paragraph(std::mem::take(&mut self.text), out);
    }

    fn flush(mut self, out: &mut Vec<Paragraph>) {
        self.flush_text(out);
    }
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

/// Text of a parsed event, with EOL normalization and no entity decoding left.
///
/// `xml_content` (not `into_inner`) because XHTML authors write `\r\n` and the
/// analyzer should see the same text a browser would.
fn decode_text(text: &quick_xml::events::BytesText<'_>) -> String {
    let content = text.xml_content(quick_xml::XmlVersion::Implicit1_0);
    content.into_owned()
}

/// A paragraph is kept when it has visible text; runs of whitespace collapse to
/// one space, because XHTML source indentation is not a paragraph break.
fn push_paragraph(text: String, out: &mut Vec<Paragraph>) {
    let mut collapsed = String::with_capacity(text.len());
    let mut space = false;
    for ch in text.chars() {
        if ch.is_whitespace() || ch == '\u{a0}' {
            space = true;
            continue;
        }
        if space && !collapsed.is_empty() {
            collapsed.push(' ');
        }
        space = false;
        collapsed.push(ch);
    }
    if !collapsed.is_empty() {
        out.push(Paragraph { text: collapsed });
    }
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
}
