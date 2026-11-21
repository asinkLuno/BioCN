# BioCN 阅读器架构复盘 — foliate-js 移植为何失败

日期: 2026-11-22 · 移植存档于分支 `foliate-attempt` (commit 8c3bf3d)，主线已回退到自渲染架构。

## 症状（用户实测）

- 下一章点不动
- 页面内容只显示一部分（约中间一段）
- 无法滚动

## 根因：前提错误，不是 bug 清单

移植把渲染交给 `foliate-js` 的 paginator（`foliate-paginator` 自定义元素）。它的三个命脉
全部发生在 **closed shadow root 内的 blob: iframe** 里：

1. **滚动**：`#container { overflow: auto }` 在 shadow DOM 内，滚轮/键盘事件被 iframe 吞掉，
   外层 `overflow: hidden` 上什么都收不到。
2. **测量**：内容高度由 paginator 用 `iframe.contentDocument` 自己量，外层只给一个
   `absolute inset-0` 的 host，量不准 = 内容被 `--_max-inline-size: 720px` + grid 裁掉
   → "页面只有一部分"。
3. **翻页**：`relocate` 事件驱动 `position` → 下一章按钮的 disabled 状态。iframe 不透出
   滚动结束时 relocate 的时序在 Tauri WebView 下不可靠 → `position === null` → 按钮永远灰
   → "下一章点不动"。

closed shadow root 意味着外部 CSS、测量、事件拦截**全都够不着**。这不是能修补的集成问题——
是"webview 必须经 foliate 渲染原书"这个前提错了。

## BioCN 实际的模型（回退后的正确架构）

```
EPUB 文件
  → Rust 解析（src-tauri/src/reader/mod.rs: paragraphs()，宽松解析、实体表、frame 语义）
  → Rust 分析（着色：主谓宾，每句每段的 segment 偏移）
  → IPC 一次一章（chapter.paragraphs）
  → React 渲染纯文本段落，sentenceBody 按 offset 切片包 <span class="svo-*">
```

**渲染的文本和分析的文本是同一份**——着色天然逐字符对齐，不需要任何"渲染后 DOM 再推导"的
环节。这就是旧 Reader.tsx（HEAD~1 版本）一直工作的原因。

foliate 唯一不可替代的价值是"书自己的排版"（EPUB 内嵌 CSS、图片、ruby）。移植期的
overlay 方案（`foliate.ts` + `overlay.ts`：渲染后 DOM 重新推导段落、全等门匹配、逆序
splitText 包 span）技术上可行，但被黑盒渲染器的滚动/翻页问题拖死。

## 若将来重启 foliate 方向（从 foliate-attempt 分支取材）

前置条件（缺一不可）：
1. **换掉 scrolled 流**——用 foliate 的 paginated 模式（它自己的滚动语义与 Tauri WebView
   兼容性更好），或干脆不用 foliate 渲染器，只用它解析 EPUB（EPUB 打开/TOC/CFI 部分是纯
   数据层，无 shadow DOM 问题）。
2. **着色注入到文档内**——在 section 的 XHTML 文本里先写入 `<span class="svo-*">`（Rust
   侧持有 per-character span 偏移，可以做到），再交给渲染器。overlay 事后推导是二等选择。
3. **CSP 加 `frame-src 'self' blob:'`**（foliate 每章一个 blob iframe；当时漏配，dev 正常、
   打包白屏——Tauri 只在 tauri:// asset HTML 上注入 CSP，devUrl 模式下不生效）。
4. **fixed-layout（pre-paginated）书走 fxl 分支**——那个渲染器没有 `setStyles`，无条件
   调用会 TypeError 被误报为"书打不开"。
5. foliate 的 spine 会压缩 dangling itemref（`.filter(s => s)`），与 rbook 的 spine order
   不对齐——坏书章号错位，需要 `detail.section?.current` 映射层。

## 决策记录

| 选择 | 结果 |
| --- | --- |
| 把整书渲染交给 foliate paginator scrolled 模式 | 失败：closed shadow DOM 黑盒，滚动/测量/翻页全部不可控 |
| overlay 事后着色（全等门 + LOOKAHEAD） | 技术可行但被 1 拖死；每章多 1 次 title 帧的 skipped |
| 整体回退（git revert） | 57 前端测试 + 123 Rust 测试全绿，回到已知良好状态 |

教训：**集成一个渲染引擎前，先确认它的滚动/测量/事件模型在你的宿主（Tauri WebView）里
工作**。closed shadow root 的自定义元素 = 渲染细节不可救。先跑一个"能滚动 + 能翻章"的
最小 spike，再写功能。
