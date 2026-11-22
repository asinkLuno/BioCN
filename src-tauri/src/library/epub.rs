//! EPUB metadata reader.
//!
//! Parsing is delegated to [`rbook`], which implements EPUB 2 and 3 container
//! handling, OPF metadata, manifest/cover discovery and href resolution
//! (percent-encoding, `..` segments, absolute paths). This module keeps only the
//! policy decisions the library needs: which values are acceptable, and limits
//! on how much is read into memory.

use std::fmt;
use std::io::{Read, Seek, Write};

/// Covers above this size are dropped instead of being stored.
const MAX_COVER_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Default, Clone)]
pub struct Metadata {
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub cover: Option<Cover>,
}

#[derive(Debug, Clone)]
pub struct Cover {
    pub bytes: Vec<u8>,
    pub mime: String,
}

#[derive(Debug)]
pub enum Error {
    /// The file is not a readable EPUB.
    Invalid(String),
    /// The EPUB was readable but something could not be read from it.
    Io(std::io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Invalid(reason) => write!(f, "不是 EPUB 文件：{reason}"),
            Error::Io(error) => write!(f, "无法读取 EPUB：{error}"),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Error::Io(value)
    }
}

/// Reads metadata from any seekable EPUB stream.
pub fn read_metadata<R: Read + Seek + Send + Sync + 'static>(reader: R) -> Result<Metadata, Error> {
    let book = rbook::Epub::read(reader).map_err(|error| invalid(&error))?;

    Ok(Metadata {
        title: title(&book),
        authors: authors(&book),
        cover: cover(&book),
    })
}

/// Turns a parser error into a message a reader of the library can understand.
///
/// The underlying errors carry archive internals (`[UnreadableArchive - None]:
/// ... EOCD`), which would be noise on the shelf.
fn invalid(error: &rbook::ebook::errors::EbookError) -> Error {
    use rbook::ebook::errors::{ArchiveError, EbookError};

    let reason = match error {
        EbookError::Archive(ArchiveError::UnreadableArchive { .. }) => {
            "这个文件不是可读的 EPUB 压缩包".to_owned()
        }
        EbookError::Archive(ArchiveError::InvalidResource { .. }) => {
            "压缩包缺少它引用的文件".to_owned()
        }
        EbookError::Format(_) => "压缩包内的包文件格式有误".to_owned(),
        other => other.to_string(),
    };
    Error::Invalid(reason)
}

/// The display title, falling back to the first non-empty one an EPUB offers.
///
/// Empty `<dc:title>` elements are common in files produced by converters, and
/// a title is required by the schema, so an empty string is not a title.
fn title(book: &rbook::Epub) -> Option<String> {
    book.metadata()
        .titles()
        .map(|title| collapse_whitespace(&title.to_string()))
        .find(|title| !title.is_empty())
}

/// The unique authors, in document order.
///
/// Repeating a creator (which happens with `refines` metadata) should not show
/// the same name twice on the tile.
fn authors(book: &rbook::Epub) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    book.metadata()
        .creators()
        .map(|creator| collapse_whitespace(&creator.to_string()))
        .filter(|name| !name.is_empty())
        .filter(|name| seen.insert(name.to_lowercase()))
        .collect()
}

/// The cover image, if the book has one that is small enough to inline.
fn cover(book: &rbook::Epub) -> Option<Cover> {
    let entry = book.manifest().cover_image()?;
    let href = entry.href().to_string();
    let mime = cover_mime(entry.kind().as_str(), &href)?;

    let mut bytes = Vec::new();
    entry
        .copy_bytes(&mut Limited {
            inner: &mut bytes,
            limit: MAX_COVER_BYTES,
        })
        .ok()?;

    Some(Cover { bytes, mime })
}

/// The image type of a cover, or `None` when the resource is not an image.
///
/// A missing `media-type` is common in hand-made packages, so the file
/// extension is used as a fallback; a declared non-image type always wins,
/// because converters sometimes point the cover at an XHTML page.
fn cover_mime(declared: &str, href: &str) -> Option<String> {
    if declared.starts_with("image/") {
        return Some(declared.to_owned());
    }
    if !declared.is_empty() {
        return None;
    }
    let extension = href.rsplit('.').next()?.to_lowercase();
    Some(mime_for_extension(&extension)?.to_owned())
}

/// The canonical image-mime table for covers: the single place where image
/// mimes, file extensions and which types the library accepts are decided.
/// `cover` derives from this; the disk store (store.rs) reads the extensions
/// off it. The accepted set must not drift between the two directions (an
/// `image/avif` cover once fell back to a `.jpg` name and was served as
/// `image/jpeg`).
#[rustfmt::skip]
pub const TABLE: &[(&str, &str)] = &[
    ("image/jpeg", "jpg"),
    ("image/png", "png"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/avif", "avif"),
    ("image/bmp", "bmp"),
    ("image/svg+xml", "svg"),
];

/// The extensions a stored cover can use, mirrored from [`TABLE`]; a unit test
/// checks the mirror stays honest.
pub const COVER_EXTENSIONS: &[&str] = &["jpg", "png", "gif", "webp", "avif", "bmp", "svg"];

/// The extension a cover with `mime` is stored under, or `None` when the
/// library does not accept this image type.
pub fn extension_for_mime(mime: &str) -> Option<&'static str> {
    TABLE
        .iter()
        .find(|&&(known, _)| known == mime)
        .map(|&(_, extension)| extension)
}

/// The mime of a stored cover file, or `None` when it is not a cover
/// extension this table knows (one direction implies the other).
pub fn mime_for_extension(extension: &str) -> Option<&'static str> {
    TABLE
        .iter()
        .find(|&&(_, known)| known == extension)
        .map(|&(mime, _)| mime)
}

/// Rejects a read that exceeds `limit` bytes instead of buffering all of it.
///
/// The size declared in the archive is untrusted, so the limit is enforced
/// while copying rather than from the header.
struct Limited<'a, W: Write> {
    inner: &'a mut W,
    limit: u64,
}

impl<W: Write> Write for Limited<'_, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.len() as u64 > self.limit {
            return Err(std::io::Error::other("超出大小上限"));
        }
        self.limit -= buf.len() as u64;
        self.inner.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// EPUB metadata is often wrapped across lines; render it as single spaces.
fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::{COVER_EXTENSIONS, TABLE, MAX_COVER_BYTES, extension_for_mime, mime_for_extension, read_metadata};
    use std::io::{Cursor, Write};

    /// Builds an EPUB around a raw OPF document.
    fn epub(opf_path: &str, opf: &str, extra: &[(&str, &[u8])]) -> Cursor<Vec<u8>> {
        use zip::ZipWriter;
        use zip::write::SimpleFileOptions;

        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        let container = format!(
            r#"<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                 <rootfiles>
                   <rootfile full-path="{opf_path}" media-type="application/oebps-package+xml"/>
                 </rootfiles>
               </container>"#
        );
        writer
            .start_file("META-INF/container.xml", options)
            .unwrap();
        writer.write_all(container.as_bytes()).unwrap();
        writer.start_file(opf_path, options).unwrap();
        writer.write_all(opf.as_bytes()).unwrap();
        for (name, body) in extra {
            writer.start_file(*name, options).unwrap();
            writer.write_all(body).unwrap();
        }
        Cursor::new(writer.finish().unwrap().into_inner())
    }

    fn package(version: &str, metadata: &str, manifest: &str) -> String {
        format!(
            r#"<package xmlns="http://www.idpf.org/2007/opf" version="{version}">
                 <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">{metadata}</metadata>
                 <manifest>{manifest}</manifest>
                 <spine/>
               </package>"#
        )
    }

    const COVER_ITEM: &str =
        r#"<item id="c" href="cover.png" media-type="image/png" properties="cover-image"/>"#;

    #[test]
    fn reads_an_epub3_package() {
        let metadata = "<dc:title>Dune</dc:title><dc:creator>Frank Herbert</dc:creator>";
        let book = read_metadata(epub(
            "OEBPS/content.opf",
            &package("3.0", metadata, COVER_ITEM),
            &[("OEBPS/cover.png", b"png bytes")],
        ))
        .expect("parses");

        assert_eq!(book.title.as_deref(), Some("Dune"));
        assert_eq!(book.authors, ["Frank Herbert"]);
        let cover = book.cover.expect("cover found");
        assert_eq!(cover.bytes, b"png bytes");
        assert_eq!(cover.mime, "image/png");
    }

    #[test]
    fn reads_an_epub2_package_with_a_doctype_and_meta_cover() {
        // EPUB 2 OPFs point at an external DTD, which a strict parser rejects.
        let opf = r#"<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE package>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Dune &amp; Messiah</dc:title>
    <dc:creator>Frank Herbert</dc:creator>
    <meta name="cover" content="img"/>
  </metadata>
  <manifest><item id="img" href="art.jpg" media-type="image/jpeg"/></manifest>
  <spine/>
</package>"#;
        let book =
            read_metadata(epub("content.opf", opf, &[("art.jpg", b"jpeg")])).expect("parses");

        assert_eq!(book.title.as_deref(), Some("Dune & Messiah"));
        assert_eq!(book.authors, ["Frank Herbert"]);
        assert_eq!(book.cover.expect("cover found").mime, "image/jpeg");
    }

    #[test]
    fn resolves_a_cover_outside_the_opf_directory() {
        let href = r#"<item id="c" href="../Images/Cover%20Art.png" media-type="image/png" properties="cover-image"/>"#;
        let book = read_metadata(epub(
            "OEBPS/text/content.opf",
            &package("3.0", "<dc:title>Escaped</dc:title>", href),
            &[("OEBPS/Images/Cover Art.png", b"png bytes")],
        ))
        .expect("parses");

        assert_eq!(book.cover.expect("cover found").bytes, b"png bytes");
    }

    #[test]
    fn skips_an_empty_title_and_duplicate_authors() {
        let metadata = "<dc:title></dc:title><dc:title>Real Title</dc:title>\
                        <dc:creator>A</dc:creator><dc:creator>B</dc:creator>\
                        <dc:creator>A</dc:creator>";
        let book =
            read_metadata(epub("c.opf", &package("3.0", metadata, ""), &[])).expect("parses");

        assert_eq!(book.title.as_deref(), Some("Real Title"));
        assert_eq!(book.authors, ["A", "B"]);
        assert!(book.cover.is_none());
    }

    #[test]
    fn ignores_a_cover_that_is_not_an_image() {
        let href = r#"<item id="c" href="c.xhtml" media-type="application/octet-stream" properties="cover-image"/>"#;
        let book = read_metadata(epub(
            "c.opf",
            &package("3.0", "<dc:title>Fake</dc:title>", href),
            &[("c.xhtml", b"not an image")],
        ))
        .expect("parses");

        assert!(book.cover.is_none(), "a non-image cover must not be stored");
    }

    #[test]
    fn the_extension_list_matches_the_mime_table() {
        for &(mime, extension) in TABLE {
            assert_eq!(mime_for_extension(extension), Some(mime));
            assert_eq!(extension_for_mime(mime), Some(extension));
            assert!(COVER_EXTENSIONS.contains(&extension));
        }
        assert_eq!(COVER_EXTENSIONS.len(), TABLE.len());
    }

    #[test]
    fn derives_a_missing_media_type_from_the_file_extension() {
        let href = r#"<item id="c" href="art/cover.jpg" properties="cover-image"/>"#;
        let book = read_metadata(epub(
            "c.opf",
            &package("3.0", "<dc:title>Untyped</dc:title>", href),
            &[("art/cover.jpg", b"jpeg")],
        ))
        .expect("parses");

        let cover = book.cover.expect("cover found");
        assert_eq!(cover.mime, "image/jpeg");
        assert_eq!(cover.bytes, b"jpeg");
    }

    #[test]
    fn drops_a_cover_larger_than_the_limit() {
        // The limit is enforced while copying, so the declared size cannot help.
        let oversized = vec![b'A'; MAX_COVER_BYTES as usize + 1];
        let book = read_metadata(epub(
            "c.opf",
            &package("3.0", "<dc:title>Big</dc:title>", COVER_ITEM),
            &[("cover.png", &oversized)],
        ))
        .expect("parses");

        assert!(
            book.cover.is_none(),
            "an oversized cover must not be inlined"
        );
    }

    #[test]
    fn reports_bytes_that_are_not_an_epub() {
        let error = read_metadata(Cursor::new(b"not a zip".to_vec())).expect_err("must fail");
        let message = error.to_string();
        assert!(
            message.starts_with("不是 EPUB 文件："),
            "意外的消息：{message}"
        );
    }
}
