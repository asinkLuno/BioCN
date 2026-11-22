//! Custom `book://` URI scheme protocol serving EPUB chapters and resources
//! directly from Rust (`rbook`), removing the need for frontend zip parsing,
//! full-book asset fetches, and `blob:` URL rewriting.
//!
//! URL shape:
//! - Linux / macOS / iOS: `book://localhost/<book_id>/<container_path>`
//! - Windows / Android:   `http://book.localhost/<book_id>/<container_path>`
//!
//! Spine XHTML chapters are served as `text/html; charset=utf-8` with:
//! 1. Cached `<span class="svo svo-*">` and paragraph anchors (`data-bp`) /
//!    progressive run markers (`data-br`) already spliced in from SQLite.
//! 2. Book `<script>` tags stripped and blocked by a per-request CSP nonce.
//! 3. BioCN reader stylesheet (`reader.css`) and tiny `postMessage` bridge
//!    (`bridge.js`) injected.
//!
//! All non-spine resources (images, CSS, fonts, SVG, media) are streamed
//! straight from the open EPUB archive with proper MIME types and CORS headers.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::http::{HeaderValue, Response, StatusCode, header};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::analyzer::build_cached_reader_html;
use crate::cache::AnalysisCache;
use crate::export::inject_stylesheet;
use crate::reader::normalize_container_path;
use crate::reading::ReadingState;

const READER_CSS: &str = include_str!("reader.css");
const BRIDGE_JS: &str = include_str!("bridge.js");
const EMBEDDED_SERIF_ROUTE: &str = "/__biocn__/fonts/SourceHanSerifSC-Regular.woff2";
const EMBEDDED_SERIF_ASSET: &str = "fonts/SourceHanSerifSC-Regular.woff2";

/// Entry point registered with `tauri::Builder::register_asynchronous_uri_scheme_protocol("book", ...)`.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let uri_path = request.uri().path().to_owned();
    let query = request.uri().query().map(str::to_owned);
    tauri::async_runtime::spawn_blocking(move || {
        let response = serve(&app, &uri_path, query.as_deref());
        responder.respond(response);
    });
}

fn serve<R: Runtime>(
    app: &AppHandle<R>,
    uri_path: &str,
    query: Option<&str>,
) -> Response<Vec<u8>> {
    if uri_path == EMBEDDED_SERIF_ROUTE {
        return serve_embedded_font(app);
    }

    let Some((book_id, resource_path)) = parse_book_uri_path(uri_path) else {
        return text_response(StatusCode::BAD_REQUEST, "invalid book resource path");
    };

    let active = match app.state::<ReadingState>().open_sync(app, &book_id) {
        Ok(active) => active,
        Err(msg) => return text_response(StatusCode::NOT_FOUND, &msg),
    };

    match active.chapter_by_href(&resource_path) {
        Ok(Some(chapter)) => {
            let cache = app.state::<AnalysisCache>().inner();
            let weights = crate::cache::weights(app).ok();
            let (colored_html, _fully_colored) =
                build_cached_reader_html(cache, weights.as_deref(), &chapter);
            let nonce = make_nonce();
            let initial = InitialStyle::from_query(query.unwrap_or(""));
            let doc = prepare_chapter_document_with_style(&colored_html, &nonce, &initial);
            let csp = format!(
                "default-src 'self' book: http://book.localhost https://book.localhost data: blob: 'unsafe-inline'; \
                 script-src 'nonce-{nonce}'; \
                 object-src 'none';"
            );
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-store")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(
                    header::CONTENT_SECURITY_POLICY,
                    HeaderValue::from_str(&csp).unwrap_or_else(|_| HeaderValue::from_static("default-src 'self'")),
                )
                .body(doc.into_bytes())
                .unwrap_or_else(|_| text_response(StatusCode::INTERNAL_SERVER_ERROR, "response build error"))
        }
        Ok(None) => match active.read_resource(&resource_path) {
            Ok(Some((bytes, mime))) => Response::builder()
                .status(StatusCode::OK)
                .header(
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(&mime)
                        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
                )
                .header(header::CACHE_CONTROL, "public, max-age=3600")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(bytes)
                .unwrap_or_else(|_| text_response(StatusCode::INTERNAL_SERVER_ERROR, "response build error")),
            Ok(None) => text_response(StatusCode::NOT_FOUND, "resource not found"),
            Err(msg) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &msg),
        },
        Err(msg) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

fn serve_embedded_font<R: Runtime>(app: &AppHandle<R>) -> Response<Vec<u8>> {
    let bytes = app
        .asset_resolver()
        .get(EMBEDDED_SERIF_ASSET.to_owned())
        .map(|asset| asset.bytes)
        .or_else(|| {
            #[cfg(debug_assertions)]
            {
                let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../public")
                    .join(EMBEDDED_SERIF_ASSET);
                std::fs::read(dev_path).ok()
            }
            #[cfg(not(debug_assertions))]
            {
                None
            }
        });

    match bytes {
        Some(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "font/woff2")
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(bytes)
            .unwrap_or_else(|_| text_response(StatusCode::INTERNAL_SERVER_ERROR, "response build error")),
        None => text_response(StatusCode::NOT_FOUND, "embedded font not found"),
    }
}

fn text_response(status: StatusCode, body: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body.as_bytes().to_vec())
        .expect("valid plain response")
}

/// Splits `/<book_id>/<container_path>` into `(book_id, normalized_container_path)`.
pub fn parse_book_uri_path(uri_path: &str) -> Option<(String, String)> {
    let trimmed = uri_path.trim_start_matches('/');
    let (raw_id, raw_rest) = trimmed.split_once('/')?;
    let book_id = percent_decode(raw_id);
    if book_id.is_empty() || book_id.contains('/') || book_id.contains("..") {
        return None;
    }
    let decoded_rest = percent_decode(raw_rest);
    let normalized = normalize_container_path(&decoded_rest)?;
    Some((book_id, normalized))
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2]))
        {
            out.push((h << 4) | l);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn make_nonce() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(seq.to_le_bytes());
    hasher.update(now.to_le_bytes());
    let digest = hasher.finalize();
    digest[..12].iter().map(|b| format!("{b:02x}")).collect()
}

/// Allowlisted initial presentation options passed via query string so the
/// very first paint of a chapter already matches the active theme and typography
/// (eliminating white/theme flashes before `bridge.js` receives `init`).
#[derive(Debug, Clone, PartialEq)]
pub struct InitialStyle {
    pub theme: &'static str,
    pub mode: &'static str,
    pub biocn: &'static str,
    pub font: &'static str,
    pub margin: &'static str,
    pub align: &'static str,
    pub dim_images: &'static str,
    pub svo_subject: Option<String>,
    pub svo_predicate: Option<String>,
    pub svo_object: Option<String>,
    pub font_size: u8,
    pub line_height: f32,
    pub para_spacing: f32,
}

impl Default for InitialStyle {
    fn default() -> Self {
        Self {
            theme: "auto",
            mode: "scrolled",
            biocn: "on",
            font: "default",
            margin: "normal",
            align: "default",
            dim_images: "on",
            svo_subject: None,
            svo_predicate: None,
            svo_object: None,
            font_size: 17,
            line_height: 1.9,
            para_spacing: 0.8,
        }
    }
}

fn parse_hex6(value: &str) -> Option<String> {
    if value.len() == 6 && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(format!("#{}", value.to_ascii_lowercase()))
    } else {
        None
    }
}

impl InitialStyle {
    pub fn from_query(query: &str) -> Self {
        let mut style = Self::default();
        for pair in query.split('&') {
            let Some((k, v)) = pair.split_once('=') else {
                continue;
            };
            match k {
                "theme" => {
                    style.theme = match v {
                        "light" => "light",
                        "sepia" => "sepia",
                        "dark" => "dark",
                        _ => "auto",
                    };
                }
                "mode" => {
                    style.mode = match v {
                        "paginated" => "paginated",
                        _ => "scrolled",
                    };
                }
                "biocn" => {
                    style.biocn = match v {
                        "off" => "off",
                        _ => "on",
                    };
                }
                "font" => {
                    style.font = match v {
                        "serif" => "serif",
                        _ => "default",
                    };
                }
                "margin" => {
                    style.margin = match v {
                        "compact" => "compact",
                        "wide" => "wide",
                        _ => "normal",
                    };
                }
                "align" => {
                    style.align = match v {
                        "justify" => "justify",
                        _ => "default",
                    };
                }
                "dim" => {
                    style.dim_images = match v {
                        "off" => "off",
                        _ => "on",
                    };
                }
                "cs" => {
                    style.svo_subject = parse_hex6(v);
                }
                "cp" => {
                    style.svo_predicate = parse_hex6(v);
                }
                "co" => {
                    style.svo_object = parse_hex6(v);
                }
                "fs" => {
                    if let Ok(n) = v.parse::<u8>() {
                        style.font_size = n.clamp(13, 28);
                    }
                }
                "lh" => {
                    if let Ok(n) = v.parse::<f32>()
                        && n.is_finite()
                    {
                        style.line_height = n.clamp(1.4, 2.4);
                    }
                }
                "ps" => {
                    if let Ok(n) = v.parse::<f32>()
                        && n.is_finite()
                    {
                        style.para_spacing = n.clamp(0.4, 2.0);
                    }
                }
                _ => {}
            }
        }
        style
    }
}

/// Prepares a chapter's colored XHTML for `text/html` iframe rendering with
/// default initial presentation.
pub fn prepare_chapter_document(html: &str, nonce: &str) -> String {
    prepare_chapter_document_with_style(html, nonce, &InitialStyle::default())
}

/// Prepares a chapter's colored XHTML for `text/html` iframe rendering:
/// strips XML declaration and book `<script>` tags, stamps initial theme/mode
/// attributes onto `<html>`, ensures `<!DOCTYPE html>`, injects BioCN base
/// stylesheet and nonced bridge script.
pub fn prepare_chapter_document_with_style(
    html: &str,
    nonce: &str,
    initial: &InitialStyle,
) -> String {
    let without_xml = strip_xml_declaration(html);
    let sanitized = strip_scripts(without_xml);
    let stamped = stamp_html_attributes(&sanitized, initial);
    let mut custom_svo = String::new();
    if let Some(hex) = &initial.svo_subject {
        custom_svo.push_str(&format!(" --svo-subject: {hex};"));
    }
    if let Some(hex) = &initial.svo_predicate {
        custom_svo.push_str(&format!(" --svo-predicate: {hex};"));
    }
    if let Some(hex) = &initial.svo_object {
        custom_svo.push_str(&format!(" --svo-object: {hex};"));
    }
    let svo_override = if custom_svo.is_empty() {
        String::new()
    } else {
        format!("\nhtml[data-theme] {{{custom_svo} }}")
    };
    let style_tag = format!(
        "<style id=\"biocn-style\">\n{READER_CSS}\n:root {{ --reader-font-size: {}px; --reader-line-height: {:.1}; --reader-para-spacing: {:.1}em; }}{svo_override}\n</style>",
        initial.font_size, initial.line_height, initial.para_spacing
    );
    let styled = inject_stylesheet(&stamped, &style_tag);
    let script_tag = format!("<script nonce=\"{nonce}\">\n{BRIDGE_JS}</script>");
    let with_bridge = inject_before_body_end(&styled, &script_tag);
    ensure_doctype(&with_bridge)
}

fn stamp_html_attributes(html: &str, initial: &InitialStyle) -> String {
    let attrs = format!(
        " data-theme=\"{}\" data-mode=\"{}\" data-biocn=\"{}\" data-font=\"{}\" data-margin=\"{}\" data-align=\"{}\" data-dim-images=\"{}\"",
        initial.theme,
        initial.mode,
        initial.biocn,
        initial.font,
        initial.margin,
        initial.align,
        initial.dim_images
    );
    if let Some(start) = find_html_open(html) {
        let after = start + "<html".len();
        let mut out = String::with_capacity(html.len() + attrs.len());
        out.push_str(&html[..after]);
        out.push_str(&attrs);
        out.push_str(&html[after..]);
        out
    } else {
        format!("<html{attrs}>{html}</html>")
    }
}

fn find_html_open(haystack: &str) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let needle = b"<html";
    let mut i = 0;
    while i + needle.len() <= bytes.len() {
        if bytes[i..i + needle.len()].eq_ignore_ascii_case(needle) {
            let next = bytes.get(i + needle.len()).copied();
            if matches!(next, Some(b'>' | b' ' | b'\t' | b'\n' | b'\r')) {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn strip_xml_declaration(html: &str) -> &str {
    let trimmed = html.trim_start_matches('\u{feff}');
    let leading = trimmed.trim_start();
    if leading.starts_with("<?xml")
        && let Some(end) = leading.find("?>")
    {
        return leading[end + 2..].trim_start();
    }
    trimmed
}

fn ensure_doctype(html: &str) -> String {
    let head = html.trim_start();
    if head.len() >= 9 && head[..9].eq_ignore_ascii_case("<!doctype") {
        html.to_owned()
    } else {
        format!("<!DOCTYPE html>\n{html}")
    }
}

/// Removes `<script>...</script>` and self-closing `<script .../>` tags from
/// EPUB content (defense-in-depth alongside CSP nonce).
pub fn strip_scripts(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = find_script_open(rest) {
        out.push_str(&rest[..start]);
        let after_open = &rest[start..];
        let Some(tag_end) = after_open.find('>') else {
            // Unclosed `<script` at EOF: drop the rest.
            return out;
        };
        let open_tag = &after_open[..=tag_end];
        if open_tag.trim_end_matches('>').trim_end().ends_with('/') {
            rest = &after_open[tag_end + 1..];
            continue;
        }
        let after_tag = &after_open[tag_end + 1..];
        if let Some(close) = find_ci(after_tag, "</script>") {
            rest = &after_tag[close + "</script>".len()..];
        } else {
            // Unclosed `<script>` block: drop to EOF.
            return out;
        }
    }
    out.push_str(rest);
    out
}

fn find_script_open(haystack: &str) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let needle = b"<script";
    let mut i = 0;
    while i + needle.len() <= bytes.len() {
        if bytes[i..i + needle.len()].eq_ignore_ascii_case(needle) {
            let next = bytes.get(i + needle.len()).copied();
            if matches!(
                next,
                None | Some(b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r')
            ) {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn inject_before_body_end(html: &str, snippet: &str) -> String {
    if let Some(at) = find_ci(html, "</body>") {
        let mut out = String::with_capacity(html.len() + snippet.len() + 2);
        out.push_str(&html[..at]);
        out.push('\n');
        out.push_str(snippet);
        out.push('\n');
        out.push_str(&html[at..]);
        out
    } else {
        format!("{html}\n{snippet}")
    }
}

fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let hay = haystack.as_bytes();
    let pat = needle.as_bytes();
    if pat.is_empty() || hay.len() < pat.len() {
        return None;
    }
    (0..=hay.len() - pat.len()).find(|&i| hay[i..i + pat.len()].eq_ignore_ascii_case(pat))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_book_uri_paths_with_percent_encoding_and_rejects_escapes() {
        assert_eq!(
            parse_book_uri_path("/abc123/OEBPS/Text/%E7%AC%AC1%E7%AB%A0.xhtml"),
            Some(("abc123".into(), "OEBPS/Text/第1章.xhtml".into()))
        );
        assert_eq!(
            parse_book_uri_path("/abc123/OEBPS/Text/../Images/a%20b.png"),
            Some(("abc123".into(), "OEBPS/Images/a b.png".into()))
        );
        assert_eq!(parse_book_uri_path("/abc123/../../etc/passwd"), None);
        assert_eq!(parse_book_uri_path("/only-id"), None);
    }

    #[test]
    fn strips_book_scripts_of_every_shape() {
        let html = r#"<head><script src="a.js"/><SCRIPT type="text/javascript">alert(1)</script></head><body><p>ok</p></body>"#;
        assert_eq!(strip_scripts(html), "<head></head><body><p>ok</p></body>");
    }

    #[test]
    fn prepares_chapter_document_with_doctype_style_and_nonced_bridge() {
        let src = r#"<?xml version="1.0" encoding="utf-8"?><html><head><title>t</title><script>evil()</script></head><body><p><span class="svo svo-subject">他</span>走了。</p></body></html>"#;
        let out = prepare_chapter_document(src, "deadbeef");
        assert!(out.starts_with("<!DOCTYPE html>"), "{out}");
        assert!(!out.contains("<?xml"), "{out}");
        assert!(!out.contains("evil()"), "{out}");
        assert!(out.contains(r#"<style id="biocn-style">"#), "{out}");
        assert!(out.contains(r#"<script nonce="deadbeef">"#), "{out}");
        assert!(out.contains(r#"<span class="svo svo-subject">他</span>"#), "{out}");
    }

    #[test]
    fn stamps_initial_theme_and_mode_from_query_before_first_paint() {
        let initial = InitialStyle::from_query(
            "v=2&theme=dark&mode=paginated&biocn=off&font=serif&margin=wide&align=justify&dim=off&cs=B03A2E&co=invalid&fs=20&lh=2.1&ps=1.4",
        );
        assert_eq!(initial.theme, "dark");
        assert_eq!(initial.mode, "paginated");
        assert_eq!(initial.biocn, "off");
        assert_eq!(initial.font, "serif");
        assert_eq!(initial.margin, "wide");
        assert_eq!(initial.align, "justify");
        assert_eq!(initial.dim_images, "off");
        assert_eq!(initial.svo_subject.as_deref(), Some("#b03a2e"));
        assert_eq!(initial.svo_object, None);
        assert_eq!(initial.font_size, 20);
        assert!((initial.line_height - 2.1).abs() < 0.01);
        assert!((initial.para_spacing - 1.4).abs() < 0.01);

        let out = prepare_chapter_document_with_style("<html><head></head><body><p>字</p></body></html>", "n1", &initial);
        assert!(
            out.contains(r#"<html data-theme="dark" data-mode="paginated" data-biocn="off" data-font="serif" data-margin="wide" data-align="justify" data-dim-images="off">"#),
            "{out}"
        );
        assert!(
            out.contains("--reader-font-size: 20px; --reader-line-height: 2.1; --reader-para-spacing: 1.4em;"),
            "{out}"
        );
        assert!(out.contains("html[data-theme] { --svo-subject: #b03a2e; }"), "{out}");
    }

    #[test]
    fn embedded_source_han_serif_font_is_valid_woff2_and_wired_in_reader_css() {
        assert!(READER_CSS.contains(EMBEDDED_SERIF_ROUTE));
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../public")
            .join(EMBEDDED_SERIF_ASSET);
        let bytes = std::fs::read(&path).expect("embedded SourceHanSerifSC-Regular.woff2 present");
        assert!(bytes.starts_with(b"wOF2"), "expected WOFF2 header");
    }
}
