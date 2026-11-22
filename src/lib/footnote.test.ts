import { describe, expect, it, vi } from "vitest";
import {
  collectTocAnchors,
  hasVisibleFootnoteContent,
  looksLikeFootnoteHref,
  parseFootnoteHtml,
} from "./footnote";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => true),
  convertFileSrc: vi.fn((_path: string, protocol = "asset") => `${protocol}://localhost/`),
}));

describe("footnote parsing & sanitization", () => {
  const ctx = { bookId: "book1", baseHref: "OEBPS/Text/notes.xhtml" };

  it("preserves rich prose, ruby annotations, and SVO spans while stripping scripts and event handlers", () => {
    const html = `
      <p><span data-bp="0"></span><span class="svo svo-subject">达尔文</span><span class="svo svo-predicate">提出</span>了<em>自然选择</em><ruby>学说<rt>xué shuō</rt></ruby>。</p>
      <script>window.__xss = true;</script>
      <style>body { display: none; }</style>
      <iframe src="https://evil.example"></iframe>
      <p onclick="alert(1)">安全段落</p>
    `;

    const nodes = parseFootnoteHtml(html, ctx);
    expect(hasVisibleFootnoteContent(nodes)).toBe(true);
    expect(JSON.stringify(nodes)).not.toContain("__xss");
    expect(JSON.stringify(nodes)).not.toContain("evil.example");
    expect(JSON.stringify(nodes)).not.toContain("display: none");
    expect(JSON.stringify(nodes)).toContain('"kind":"svo","role":"subject"');
    expect(JSON.stringify(nodes)).toContain('"kind":"svo","role":"predicate"');
    expect(JSON.stringify(nodes)).toContain('"tag":"ruby"');
    expect(JSON.stringify(nodes)).toContain("安全段落");
  });

  it("sanitizes link schemes and resolves safe book images while blocking external trackers", () => {
    const html = `
      <p>
        <a href="https://example.org/ref">外链</a>
        <a href="javascript:alert(1)">恶意链接</a>
        <a href="../Text/ch2.xhtml#sec2">第二章</a>
        <img src="../Images/fig1.png" alt="示意图" />
        <img src="https://tracker.example/pixel.gif" alt="追踪像素" />
        <img src="data:image/png;base64,AAAA" alt="内嵌图" />
      </p>
    `;

    const nodes = parseFootnoteHtml(html, ctx);
    const json = JSON.stringify(nodes);
    expect(json).toContain('"linkType":"external","href":"https://example.org/ref"');
    expect(json).toContain('"linkType":"internal","path":"OEBPS/Text/ch2.xhtml","anchor":"sec2"');
    expect(json).not.toContain("javascript:");
    expect(json).toContain("恶意链接");
    expect(json).toContain("book://localhost/book1/OEBPS/Images/fig1.png");
    expect(json).toContain("data:image/png;base64,AAAA");
    expect(json).not.toContain("tracker.example");
  });

  it("detects empty content after stripping forbidden nodes", () => {
    const nodes = parseFootnoteHtml("<script>bad()</script>   ", ctx);
    expect(hasVisibleFootnoteContent(nodes)).toBe(false);
  });
});

describe("footnote href classification and TOC exclusion", () => {
  it("recognizes likely footnote hrefs and ignores plain chapter/section links", () => {
    expect(looksLikeFootnoteHref("OEBPS/Text/ch2.xhtml", "fn1")).toBe(true);
    expect(looksLikeFootnoteHref("OEBPS/Text/endnotes.xhtml", "n-12")).toBe(true);
    expect(looksLikeFootnoteHref("OEBPS/Text/notes.xhtml", "item1")).toBe(true);
    expect(looksLikeFootnoteHref("OEBPS/Text/ch1.xhtml", "s1")).toBe(false);
    expect(looksLikeFootnoteHref("OEBPS/Text/notes.xhtml", null)).toBe(false);
  });

  it("collects nested TOC anchors keyed by chapter href", () => {
    const anchors = collectTocAnchors(
      [
        {
          label: "第一章",
          chapterIndex: 1,
          anchor: null,
          subitems: [{ label: "第一节", chapterIndex: 1, anchor: "s1", subitems: [] }],
        },
        { label: "尾注", chapterIndex: 2, anchor: "notes-top", subitems: [] },
      ],
      [
        { index: 1, manifestId: "c1", href: "OEBPS/Text/ch1.xhtml", title: "一", colored: false },
        { index: 2, manifestId: "c2", href: "OEBPS/Text/notes.xhtml", title: "注", colored: false },
      ],
    );
    expect(anchors.has("OEBPS/Text/ch1.xhtml#s1")).toBe(true);
    expect(anchors.has("OEBPS/Text/notes.xhtml#notes-top")).toBe(true);
    expect(anchors.has("OEBPS/Text/notes.xhtml#fn1")).toBe(false);
  });
});
