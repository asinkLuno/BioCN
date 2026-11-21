/**
 * Parity tests between the DOM overlay and the Rust parser.
 *
 * The analyzer's offsets are only as good as this side's paragraph list:
 * every case here mirrors one of `src-tauri/src/reader/mod.rs`'s tests, so a
 * rule that drifts on either side breaks the same fixture on both. Painting
 * cases pin how offsets become spans, including across inline markup and
 * through a surrogate pair.
 */
import { describe, expect, it } from "vitest";
import type { ColoredParagraph, ColoredSentence, Segment } from "./reading";
import { BOOK_STYLESHEET, enumerateParagraphs, paintChapter } from "./overlay";

/** Parses like foliate's fallback does — as HTML, entities and all. */
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

const texts = (html: string) =>
  enumerateParagraphs(parse(html).documentElement).map((collapsed) => collapsed.text);

const segment = (text: string, start: number, role: Segment["role"]): Segment => ({
  text,
  start,
  role,
});

const sentence = (text: string, start: number, segments: Segment[]): ColoredSentence => ({
  text,
  start,
  segments,
});

const paragraph = (text: string, sentences: ColoredSentence[]): ColoredParagraph => ({
  text,
  sentences,
});

describe("paragraph enumeration (mirrors the Rust parser's tests)", () => {
  it("takes one paragraph per block element", () => {
    expect(texts("<html><body><p>第一段。</p><p>第二段。</p></body></html>")).toEqual([
      "第一段。",
      "第二段。",
    ]);
  });

  it("flattens inline markup into the paragraph", () => {
    expect(texts('<body><p>他说：<em>走</em>吧<span class="x">。</span></p></body>')).toEqual([
      "他说：走吧。",
    ]);
  });

  it("collapses source indentation but keeps spaces between words", () => {
    expect(texts("<body>\n  <p>\n    第一句。\n    第二句。\n  </p>\n</body>")).toEqual([
      "第一句。 第二句。",
    ]);
  });

  it("skips script, style and ruby annotations", () => {
    expect(
      texts(`<body>
        <style>p { color: red }</style>
        <p>正文。</p>
        <p><ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby></p>
        <script>alert(1)</script>
      </body>`),
    ).toEqual(["正文。", "漢字"]);
  });

  it("drops an empty or whitespace-only paragraph", () => {
    expect(texts("<body><p>　</p><p> </p><p>有字。</p></body>")).toEqual(["有字。"]);
  });

  it("ends the paragraph before a nested block, in reading order", () => {
    expect(texts("<body><div>第一段<div>内层</div>第三段</div></body>")).toEqual([
      "第一段",
      "内层",
      "第三段",
    ]);
  });

  it("gives a wrapper element around paragraphs no paragraph of its own", () => {
    expect(texts('<body><div class="body"><p>一。</p><p>二。</p><p>三。</p></div></body>')).toEqual([
      "一。",
      "二。",
      "三。",
    ]);
  });

  it("reads a br-separated div as one paragraph", () => {
    expect(texts("<body><div>第一行<br/>第二行</div></body>")).toEqual(["第一行 第二行"]);
  });

  it("does not duplicate a list item's text for the paragraph it holds", () => {
    expect(texts("<body><ul><li><p>条目一。</p></li><li>条目二。</li></ul></body>")).toEqual([
      "条目一。",
      "条目二。",
    ]);
  });

  it("resolves the HTML entities prose uses", () => {
    expect(texts("<body><p>a&mdash;b&hellip;&#65;&#x42;</p></body>")).toEqual(["a—b…AB"]);
  });

  it("collapses a non-breaking space like any other space", () => {
    // The entity form (the DOM resolves it to U+00A0) and the literal form
    // must behave the same; the analyzer never sees U+00A0 twice in a row.
    expect(texts("<body><p>a&nbsp;b</p></body>")).toEqual(["a b"]);
    expect(texts("<body><p>a\u00a0b</p></body>")).toEqual(["a b"]);
  });

  it("drops a paragraph with only markup in it", () => {
    expect(texts('<body><p><img src="a.png"/></p><p>字。</p></body>')).toEqual(["字。"]);
  });

  it("makes a document title the first paragraph, like the parser does", () => {
    // The Rust parser walks the whole document, so `<head>`'s text is
    // collected by the open `<html>` frame and flushed when `<body>` opens.
    // The overlay must produce the same list or every offset after it drifts.
    expect(
      texts("<html><head><title>第一章 测试</title></head><body><p>正文。</p></body></html>"),
    ).toEqual(["第一章 测试", "正文。"]);
  });
});

describe("paintChapter", () => {
  const doc = (html: string) => parse(html).documentElement.ownerDocument!;

  const spansOf = (root: Element, selector: string) =>
    Array.from(root.querySelectorAll(selector)).map((span) => span.textContent);

  it("wraps role spans and keeps every character of the paragraph", () => {
    const document = doc("<body><p>他说：<em>走</em>吧。</p></body>");
    const stats = paintChapter(document, [
      paragraph("他说：走吧。", [
        sentence("他说：走吧。", 0, [
          segment("他说", 0, "subject"),
          segment("走", 3, "predicate"),
          segment("吧", 4, "object"),
        ]),
      ]),
    ]);
    expect(stats).toEqual({ painted: 1, skipped: 0 });
    const p = document.querySelector("p")!;
    // The predicate span lives inside the book's own <em>: coloring must
    // follow the original markup, not replace it.
    expect(p.querySelector("em .svo-predicate")?.textContent).toBe("走");
    expect(spansOf(p, ".svo-subject")).toEqual(["他说"]);
    expect(spansOf(p, ".svo-object")).toEqual(["吧"]);
    // Nothing dropped, nothing duplicated.
    expect(p.textContent).toBe("他说：走吧。");
  });

  it("splits one text node for several consecutive spans", () => {
    const document = doc("<body><p>甲乙丙丁。</p></body>");
    paintChapter(document, [
      paragraph("甲乙丙丁。", [
        sentence("甲乙丙丁。", 0, [
          segment("甲", 0, "subject"),
          segment("乙", 1, "predicate"),
          segment("丙", 2, "object"),
        ]),
      ]),
    ]);
    const p = document.querySelector("p")!;
    expect(spansOf(p, ".svo")).toEqual(["甲", "乙", "丙"]);
    expect(p.textContent).toBe("甲乙丙丁。");
    // The untouched tail stays bare text: 丁 was never colored by the analyzer.
    expect(p.lastChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(p.lastChild?.textContent).toBe("丁。");
  });

  it("paints through a surrogate pair with offsets staying UTF-16 aligned", () => {
    const document = doc("<body><p>𠀀字。</p></body>");
    paintChapter(document, [
      // 𠀀 is one code point, two UTF-16 units: the analyzer's offsets are
      // string indices, and one misalignment would paint 字 as 𠀀.
      paragraph("𠀀字。", [sentence("𠀀字。", 0, [segment("𠀀字", 0, "subject")])]),
    ]);
    expect(document.querySelector(".svo-subject")?.textContent).toBe("𠀀字");
    expect(document.querySelector("p")!.textContent).toBe("𠀀字。");
  });

  it("leaves the gaps between sentences and normal segments uncolored", () => {
    const document = doc("<body><p>He slept. She woke.</p></body>");
    paintChapter(document, [
      paragraph("He slept. She woke.", [
        sentence("He slept.", 0, [segment("He", 0, "subject"), segment("slept.", 3, "predicate")]),
        sentence("She woke.", 10, [segment("She", 0, "subject")]),
      ]),
    ]);
    const p = document.querySelector("p")!;
    expect(spansOf(p, ".svo-subject")).toEqual(["He", "She"]);
    expect(spansOf(p, ".svo-predicate")).toEqual(["slept."]);
    expect(p.textContent).toBe("He slept. She woke.");
  });

  it("leaves an unmatched paragraph untouched", () => {
    const document = doc("<body><p>完全不同的文本。</p></body>");
    const stats = paintChapter(document, [
      paragraph("分析器的那段话。", [
        sentence("分析器的那段话。", 0, [segment("分析器", 0, "subject")]),
      ]),
    ]);
    expect(stats).toEqual({ painted: 0, skipped: 1 });
    expect(document.querySelectorAll(".svo").length).toBe(0);
    expect(document.querySelector("p")!.textContent).toBe("完全不同的文本。");
  });

  it("skips a sentence whose offsets do not line up with its text", () => {
    const document = doc("<body><p>正文在这里。</p></body>");
    const stats = paintChapter(document, [
      paragraph(
        "正文在这里。",
        // The text matches, but the sentence claims to start mid-paragraph —
        // painting it would color the wrong characters.
        [sentence("正文在这里。", 2, [segment("正文", 0, "subject")])],
      ),
    ]);
    expect(stats.painted).toBe(0);
    expect(document.querySelectorAll(".svo").length).toBe(0);
  });

  it("paints an uncolored book's sections as nothing at all", () => {
    const document = doc("<body><p>没有模型，也有排版。</p></body>");
    const stats = paintChapter(document, [paragraph("没有模型，也有排版。", [])]);
    expect(stats).toEqual({ painted: 0, skipped: 0 });
    expect(document.querySelectorAll(".svo").length).toBe(0);
  });
});

describe("BOOK_STYLESHEET", () => {
  it("carries the token colors the export stylesheet pins", () => {
    // The six hex values are shared with src/index.css and export.rs; this
    // pins the light set so a change here is a deliberate one.
    expect(BOOK_STYLESHEET).toContain(".svo-subject { color: #d95f02; }");
    expect(BOOK_STYLESHEET).toContain(".svo-predicate { color: #1b9e77; }");
    expect(BOOK_STYLESHEET).toContain(".svo-object { color: #7570b3; }");
  });
});
