import { describe, expect, it } from "vitest";
import { compareVersions, parseReleaseNotes } from "./update";

describe("compareVersions", () => {
  it("orders versions by each numeric segment", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("0.4.10", "0.4.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("pads the shorter version with zeros", () => {
    // "0.2" is 0.2.0, so the same release written either way is not an update.
    expect(compareVersions("0.2", "0.2.0")).toBe(0);
    expect(compareVersions("0.2", "0.2.1")).toBe(-1);
  });

  it("treats unparsable segments as zero rather than crashing", () => {
    // A tag with a suffix ("0.3.0-beta") only ever reaches the comparison
    // through package_info versions, which are plain numbers — but a dirty
    // metadata file must not throw inside the sheet.
    expect(compareVersions("0.3.0-beta", "0.3.0")).toBe(0);
  });
});

describe("parseReleaseNotes", () => {
  it("skips the redundant version header and groups headings, bullets, and baseline text", () => {
    const md = [
      "## ✨ v0.5.0 更新内容",
      "",
      "更新基线：在 v0.4.1 基础上重构阅读器。",
      "",
      "### 新功能",
      "- **阅读器**：支持 `EPUB` 脚注浮层",
      "- 见 [说明](https://example.com)",
      "",
      "**Full Changelog**: https://github.com/asinkLuno/BioCN/compare/v0.4.1...v0.5.0",
    ].join("\n");

    expect(parseReleaseNotes(md)).toEqual([
      { kind: "text", text: "更新基线：在 v0.4.1 基础上重构阅读器。" },
      { kind: "heading", text: "新功能" },
      { kind: "list", items: ["阅读器：支持 EPUB 脚注浮层", "见 说明"] },
      {
        kind: "changelog",
        label: "查看完整变更对比",
        url: "https://github.com/asinkLuno/BioCN/compare/v0.4.1...v0.5.0",
      },
    ]);
  });

  it("handles legacy auto-generated Full Changelog notes", () => {
    expect(
      parseReleaseNotes(
        "**Full Changelog**: https://github.com/asinkLuno/BioCN/compare/v0.1.0...v0.2.0",
      ),
    ).toEqual([
      {
        kind: "changelog",
        label: "查看完整变更对比",
        url: "https://github.com/asinkLuno/BioCN/compare/v0.1.0...v0.2.0",
      },
    ]);
  });

  it("does not turn non-GitHub URLs into changelog links", () => {
    expect(parseReleaseNotes("**Full Changelog**: https://evil.example/compare/a...b")).toEqual([
      { kind: "text", text: "Full Changelog: https://evil.example/compare/a...b" },
    ]);
  });

  it("returns nothing for empty notes", () => {
    expect(parseReleaseNotes("")).toEqual([]);
  });
});
