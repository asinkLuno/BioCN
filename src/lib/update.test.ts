import { describe, expect, it } from "vitest";
import { compareVersions, plainNotes } from "./update";

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

describe("plainNotes", () => {
  it("strips markdown markup and keeps list items as lines", () => {
    expect(
      plainNotes("### 修复\n- **阅读器**：翻页不丢位置\n见 [说明](https://example.com)"),
    ).toEqual(["修复", "- 阅读器：翻页不丢位置", "见 说明"]);
  });

  it("drops blank lines but keeps inline code readable", () => {
    expect(plainNotes("新增\n\n支持 `EPUB` 导入\n")).toEqual(["新增", "支持 EPUB 导入"]);
  });

  it("keeps the Full Changelog line the release bot generates", () => {
    expect(
      plainNotes("**Full Changelog**: https://github.com/asinkLuno/bioCN/compare/v0.1.0...v0.2.0"),
    ).toEqual(["Full Changelog: https://github.com/asinkLuno/bioCN/compare/v0.1.0...v0.2.0"]);
  });

  it("returns nothing for empty notes", () => {
    expect(plainNotes("")).toEqual([]);
  });
});
