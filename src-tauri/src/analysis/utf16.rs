//! UTF-16 text helpers.
//!
//! All offsets in this crate are UTF-16 code-unit offsets, exactly like the
//! TypeScript implementation (`src/lib/biocn/*.ts`): those offsets are what
//! the frontend turns into DOM `Range`s, so they must not drift to code
//! points or bytes.

/// Number of UTF-16 code units of `s` (== JS `s.length`).
#[inline]
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Borrow a `&str` as UTF-16 code units.
#[inline]
pub fn to_utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// UTF-16 code units back into a `String` (lone surrogates → U+FFFD).
#[inline]
pub fn from_utf16(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// Decode the scalar starting at UTF-16 index `i`; returns `(char, width)`.
///
/// Width is 2 for a surrogate pair, 1 otherwise. A lone surrogate decodes to
/// U+FFFD (JS would keep the unpaired code unit; nothing downstream can tell
/// the difference, since U+FFFD is not CJK/punct/space either).
#[inline]
pub fn next_char(text: &[u16], i: usize) -> (char, usize) {
    let first = text[i];
    if (0xD800..0xDC00).contains(&first) && i + 1 < text.len() {
        let second = text[i + 1];
        if (0xDC00..0xE000).contains(&second) {
            let cp = 0x10000 + (((first as u32 - 0xD800) << 10) | (second as u32 - 0xDC00));
            return (char::from_u32(cp).unwrap_or('\u{FFFD}'), 2);
        }
    }
    (char::from_u32(first as u32).unwrap_or('\u{FFFD}'), 1)
}

/// `haystack.indexOf(needle, from)` in UTF-16 space.
pub fn find_utf16(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(haystack.len()));
    }
    if from >= haystack.len() || needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&i| &haystack[i..i + needle.len()] == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn astral_width() {
        let t = to_utf16("a龘😀");
        assert_eq!(t.len(), 4); // 1 + 1 + 2
        assert_eq!(next_char(&t, 0), ('a', 1));
        assert_eq!(next_char(&t, 1), ('龘', 1));
        assert_eq!(next_char(&t, 2), ('😀', 2));
        assert_eq!(utf16_len("a龘😀"), 4);
    }

    #[test]
    fn index_of() {
        let hay = to_utf16("小明吃苹果");
        assert_eq!(find_utf16(&hay, &to_utf16("苹果"), 0), Some(3));
        assert_eq!(find_utf16(&hay, &to_utf16("苹果"), 4), None);
        assert_eq!(find_utf16(&hay, &to_utf16("小明"), 0), Some(0));
    }
}
