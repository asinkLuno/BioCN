//! Sentence splitting: EPUB paragraphs in, sentence ranges out.
//!
//! Upstream bioCN (the web version) calls HanLP's `split_sentence` here. The
//! reader keeps the same contract — paragraph-local, contiguous ranges so a
//! caller can map a sentence to the offsets the DOM highlights — and its own
//! rules ([`corrected`]), which fix the two bugs that mattered on real books:
//! a `。」` closer cut in half, and `？！` split down the middle.
//!
//! Ranges are byte offsets into the input rather than `&str`: the caller needs
//! the offset to place the highlighted spans, and re-searching for the sentence
//! text is exactly the `text.find(...)` step that silently drops sentences when
//! a paragraph repeats one.

mod corrected;

use std::ops::Range;

pub use corrected::corrected;

/// Splits `text` into sentence byte ranges, trimmed, in order.
pub fn split(text: &str) -> Vec<Range<usize>> {
    corrected(text)
}

/// The sentence strings of a split, for callers that do not need offsets.
pub fn sentences(text: &str) -> Vec<&str> {
    split(text).into_iter().map(|range| &text[range]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_plain_sentences() {
        let text = "他走了。她留下来。天黑了。";
        assert_eq!(sentences(text), ["他走了。", "她留下来。", "天黑了。"]);
    }

    #[test]
    fn blank_input_yields_nothing() {
        for text in ["", "   ", "\n\n", "\u{3000}"] {
            assert!(split(text).is_empty(), "{text:?}");
        }
    }

    /// Every returned range must be a slice of the input, so a caller can map
    /// it back to a paragraph offset without re-searching.
    #[test]
    fn returned_ranges_are_usable_slices_of_the_input() {
        let text = "第一句。第二句！第三句？";
        for sentence in split(text) {
            assert!(sentence.end <= text.len());
            let slice = &text[sentence];
            assert_eq!(slice, slice.trim());
            assert!(!slice.is_empty());
        }
    }
}
