#!/usr/bin/env node
// 从 demo 文本生成思源宋体子集（website/public/fonts/shs-demo.woff2）。
//
// 为什么是“文本子集”而不是 unicode-range 切片：只有主页 demo 段落用宋体，
// 文本固定且很短（~150 字）；单文件 64KB 一次请求，比任何切片方案都省。
//
// 文本变动后重新生成：node scripts/build-font-subset.mjs
//   - 需要 devDependencies 里的 subset-font
//   - 需要完整版思源宋体：npm run fetch-font-source 下载到
//     node_modules/.font-source/SourceHanSerifSC-Regular.otf（~24MB，git 忽略）
//
// 缺字保护：生成的字体只含枚举到的字符。脚本会同时产出
// src/fonts/shs-demo.css 里的 unicode-range 注释清单；若日后段落新增生僻字，
// 该字不在子集里会回退到系统宋体（font-family 栈的 ui-serif/serif），
// 不会白块。改完文案跑一次本脚本即可补齐。

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import subsetFont from 'subset-font';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/main.tsx');
const OUT_WOFF2 = path.join(ROOT, 'public/fonts/shs-demo.woff2');
const OUT_CSS = path.join(ROOT, 'src/fonts/shs-demo.css');
const FONT_SRC = path.join(ROOT, 'node_modules/.font-source/SourceHanSerifSC-Regular.otf');
const FONT_URL =
  'https://raw.githubusercontent.com/adobe-fonts/source-han-serif/release/OTF/SimplifiedChinese/SourceHanSerifSC-Regular.otf';

// 1. 从 main.tsx 抽取 demo 文本（text: '...' 字面量），剥掉着色 <span> 标签
const tsx = fs.readFileSync(SRC, 'utf8');
const demoTexts = [...tsx.matchAll(/text: '([^']+)'/g)].map((m) => m[1])
  .join('')
  .replace(/<[^>]+>/g, '');

// 2. demo 周边以宋体渲染的固定文案（与 Paragraph 同样 font-serif 的内容）+ 常用标点
const extra = '仿生阅读主语谓语宾语？。；，：、""「」『』（）';

const chars = [...new Set([...(demoTexts + extra)])].join('');
if (chars.length < 100) {
  console.error(`抽取到的字符过少（${chars.length}），解析逻辑可能失效，中止。`);
  process.exit(1);
}

// 3. 完整版字体就位（下载一次，缓存到 node_modules/.font-source/）
if (!fs.existsSync(FONT_SRC)) {
  console.log('下载完整版思源宋体（约 24MB，仅一次）…');
  fs.mkdirSync(path.dirname(FONT_SRC), { recursive: true });
  execSync(`curl -fsSL --retry 3 -o "${FONT_SRC}" "${FONT_URL}"`, { stdio: 'inherit' });
}

// 4. 子集化

subsetFont(fs.readFileSync(FONT_SRC), chars, { targetFormat: 'woff2' }).then((buf) => {
  fs.mkdirSync(path.dirname(OUT_WOFF2), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_CSS), { recursive: true });
  fs.writeFileSync(OUT_WOFF2, buf);
  fs.writeFileSync(
    OUT_CSS,
    `/* 由 scripts/build-font-subset.mjs 生成，勿手改。`
    + `字符集：${chars.length} 字，${buf.length} 字节。重新生成见该脚本头注释。 */\n`
    + `@font-face {\n`
    + `  font-family: 'Noto Serif SC';\n`
    + `  font-style: normal;\n`
    + `  font-weight: 400;\n`
    + `  font-display: swap;\n`
    + `  src: url('/fonts/shs-demo.woff2') format('woff2');\n`
    + `}\n`,
  );
  console.log(`OK: ${OUT_WOFF2} (${chars.length} 字, ${(buf.length / 1024).toFixed(1)} KB)`);
}).catch((e) => { console.error('subset 失败:', e.message); process.exit(1); });
