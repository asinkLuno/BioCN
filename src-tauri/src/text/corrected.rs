//! The sentence splitter the reader uses.
//!
//! Upstream bioCN splits each paragraph with `hanlp.utils.rules.split_sentence`
//! (a plain regex pass, no model). This module is the app's own rules on the
//! same contract: one paragraph in, contiguous trimmed ranges out. Where the
//! two disagree (`「走吧。」「好。」`, `？！`), this module is right; splitting is
//! a preprocessing step, not something the user reads raw.

use std::ops::Range;

fn is_terminator(ch: char) -> bool {
    matches!(ch, '。' | '！' | '？' | '?' | '!' | '.' | '…')
}

/// Characters that belong to the sentence before them: quotes and brackets a
/// reader would never want separated from the `。` they follow.
fn is_closer(ch: char) -> bool {
    matches!(
        ch,
        '”' | '’' | '"' | '\'' | '」' | '』' | '》' | '〉' | '】' | '〕' | '）' | ')' | '］' | ']'
    )
}

/// `Mr.`, `U.S.` and friends: a `.` that a word character follows is part of an
/// abbreviation, not the end of a sentence.
///
/// `chars` is the whole paragraph and `at` indexes the `.`; the caller passed
/// over any closing quotes already.
fn is_abbreviation_dot(chars: &[(usize, char)], at: usize, after: usize) -> bool {
    // `\s(\w)`: the whitespace the abbreviation was written with is skipped.
    let mut next = after;
    while chars.get(next).is_some_and(|(_, ch)| ch.is_whitespace()) {
        next += 1;
    }
    let Some((_, word)) = chars.get(next) else {
        return false;
    };
    if !(word.is_alphanumeric() || *word == '_') {
        return false;
    }
    // `[A-Z][a-z]{1,2}\.` — `Mr.`, `Dr.`, `Jan.`
    let senior = matches!(
        (at.checked_sub(1).and_then(|i| chars.get(i)),
         at.checked_sub(2).and_then(|i| chars.get(i)),
         at.checked_sub(3).and_then(|i| chars.get(i))),
        (Some((_, b)), Some((_, a)), Some((_, upper)))
            if upper.is_ascii_uppercase() && a.is_ascii_lowercase() && b.is_ascii_lowercase()
    );
    // `[A-Z][a-z]\.`
    let shorter = matches!(
        (
            at.checked_sub(1).and_then(|i| chars.get(i)),
            at.checked_sub(2).and_then(|i| chars.get(i)),
        ),
        (Some((_, a)), Some((_, upper)))
            if upper.is_ascii_uppercase() && a.is_ascii_lowercase()
    );
    // `\.[a-zA-Z]\.` — `U.S.`, `e.g.`
    let acronym = matches!(
        (
            at.checked_sub(1).and_then(|i| chars.get(i)),
            at.checked_sub(2).and_then(|i| chars.get(i)),
        ),
        (Some((_, letter)), Some((_, dot))) if letter.is_ascii_alphabetic() && *dot == '.'
    );
    senior || shorter || acronym
}

/// A `.` is only a terminator when nothing that continues a word follows it.
///
/// `3.14`, `1.2.3` and `a.b` therefore stay whole, and so does every sentence
/// whose period is followed by a space or the end of the paragraph.
fn is_latin_period(chars: &[(usize, char)], at: usize, after: usize) -> bool {
    if !chars[at + 1..after].iter().all(|(_, ch)| is_closer(*ch)) {
        return false;
    }
    match chars.get(after) {
        None => true,
        Some((_, ch)) => ch.is_whitespace() || is_closer(*ch),
    }
}

pub fn corrected(text: &str) -> Vec<Range<usize>> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i].1;
        if ch == '\n' {
            // A line break inside a paragraph ends a sentence that has no
            // terminator of its own (verse, a title, a heading in the middle of
            // a `<p>`), and a blank line always does.
            push(text, &chars, start, i, &mut out);
            start = i + 1;
            i += 1;
            continue;
        }
        if !is_terminator(ch) {
            i += 1;
            continue;
        }
        // A doubled ellipsis is a terminator; a single `…` is a pause. Same
        // spirit as upstream's `…{2}` rule, without the second regex pass.
        if ch == '…' && chars.get(i + 1).map(|(_, next)| *next) != Some('…') {
            i += 1;
            continue;
        }

        // Consume the run of terminators (`？！`, `。。。`, `……`) and then any
        // closers, so the sentence boundary sits after the last one.
        let mut end = i;
        while end < chars.len() && is_terminator(chars[end].1) {
            end += 1;
        }
        while end < chars.len() && is_closer(chars[end].1) {
            end += 1;
        }

        // Guards only matter for the Latin period: a Chinese terminator always
        // ends a sentence, whatever follows. Six dots are upstream's ellipsis
        // and end a sentence on their own, so they skip the guards.
        if ch == '.' {
            let dots = chars[i..end]
                .iter()
                .take_while(|(_, ch)| *ch == '.')
                .count();
            if dots < 6 && (!is_latin_period(&chars, i, end) || is_abbreviation_dot(&chars, i, end))
            {
                i += 1;
                continue;
            }
        }

        push(text, &chars, start, end, &mut out);
        start = end;
        i = end;
    }
    push(text, &chars, start, chars.len(), &mut out);
    out
}

/// Trim `chars[start..end]` and record it as a byte range of `text`.
fn push(
    text: &str,
    chars: &[(usize, char)],
    start: usize,
    end: usize,
    out: &mut Vec<Range<usize>>,
) {
    if start >= end || end > chars.len() {
        return;
    }
    let from = chars[start].0;
    let last = &chars[end - 1];
    let to = last.0 + last.1.len_utf8();
    let slice = &text[from..to];
    let trimmed = slice.trim();
    if trimmed.is_empty() {
        return;
    }
    let lead = slice.len() - slice.trim_start().len();
    out.push(from + lead..from + lead + trimmed.len());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(text: &str) -> Vec<&str> {
        corrected(text)
            .into_iter()
            .map(|range| &text[range])
            .collect()
    }

    #[test]
    fn splits_plain_chinese_sentences() {
        assert_eq!(split("他走了。她来了。"), ["他走了。", "她来了。"]);
        assert_eq!(split("你好"), ["你好"]);
    }

    #[test]
    fn a_closing_quote_belongs_to_the_sentence() {
        assert_eq!(split("「走吧。」「好。」"), ["「走吧。」", "「好。」"]);
        assert_eq!(
            split("他说：“走。”然后走了。"),
            ["他说：“走。”", "然后走了。"]
        );
        assert_eq!(split("（他走了。）她留下。"), ["（他走了。）", "她留下。"]);
        assert_eq!(split("《书名》。下一句。"), ["《书名》。", "下一句。"]);
    }

    #[test]
    fn a_run_of_terminators_is_one_ending() {
        assert_eq!(split("？！"), ["？！"]);
        assert_eq!(split("真的吗？！不会吧！！"), ["真的吗？！", "不会吧！！"]);
    }

    #[test]
    fn ellipses_and_dots_end_a_sentence_only_when_doubled() {
        assert_eq!(split("……好"), ["……", "好"]);
        assert_eq!(split("…好"), ["…好"]);
        assert_eq!(split("......好"), ["......", "好"]);
        // Three dots are a pause (upstream agrees: `等等...好` stays whole).
        assert_eq!(split("等等...好"), ["等等...好"]);
    }

    #[test]
    fn a_latin_period_needs_whitespace_or_an_end_after_it() {
        assert_eq!(split("He slept. She woke."), ["He slept.", "She woke."]);
        assert_eq!(split("圆周率是 3.14 左右"), ["圆周率是 3.14 左右"]);
        assert_eq!(split("a.b"), ["a.b"]);
    }

    #[test]
    fn abbreviations_do_not_end_a_sentence() {
        assert_eq!(
            split("Mr. Smith went home. He slept."),
            ["Mr. Smith went home.", "He slept."]
        );
        assert_eq!(split("Dr. Wang 来了。"), ["Dr. Wang 来了。"]);
        assert_eq!(split("the U.S. Army"), ["the U.S. Army"]);
    }

    #[test]
    fn newlines_and_blank_paragraphs_are_respected() {
        assert_eq!(split("第一段\n第二段"), ["第一段", "第二段"]);
        assert_eq!(split("  第一段  \n\n  第二段 "), ["第一段", "第二段"]);
    }

    #[test]
    fn ranges_are_trimmed_and_point_into_the_input() {
        let text = "  他走了。  她来了。  ";
        let ranges = corrected(text);
        assert_eq!(ranges.len(), 2);
        for range in &ranges {
            assert_eq!(&text[range.clone()], text[range.clone()].trim());
        }
        assert_eq!(&text[ranges[1].clone()], "她来了。");
    }

    #[test]
    fn every_character_ends_up_in_exactly_one_sentence() {
        // Concatenating the pieces (modulo the whitespace they were trimmed of)
        // must reproduce the paragraph; nothing may be dropped.
        for text in [
            "「走吧。」「好。」",
            "他走了。她来了！你好？",
            "……好。然后呢……",
            "Mr. Smith. 3.14 and 1.2.3.",
        ] {
            let joined: String = corrected(text)
                .into_iter()
                .map(|range| &text[range])
                .collect::<Vec<_>>()
                .join(" ");
            let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
            assert_eq!(squash(&joined), squash(text), "{text}");
        }
    }

    #[test]
    fn a_terminator_at_the_very_end_does_not_emit_an_empty_sentence() {
        assert_eq!(split("走了。"), ["走了。"]);
        assert_eq!(split("。"), ["。"]);
    }
}
