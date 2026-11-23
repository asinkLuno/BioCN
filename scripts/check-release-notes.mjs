// 校验根目录 release-notes.md 与当前应用版本匹配且内容完整。
// 用法：node scripts/check-release-notes.mjs [--file release-notes.md] [--version X.Y.Z]
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const fileArg = option('--file') ?? 'release-notes.md';
const filePath = path.isAbsolute(fileArg) ? fileArg : path.join(root, fileArg);

let version = option('--version');
if (!version) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  version = pkg.version;
}
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`无效的应用版本号：${String(version)}`);
}

let raw;
try {
  raw = await readFile(filePath, 'utf8');
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    console.error(
      `缺少 ${fileArg}。发版前请先生成并润色当前版本的更新说明：\n` +
        `  yarn release:notes:draft -- --write\n` +
        `  yarn release:notes:check`,
    );
    process.exit(1);
  }
  throw error;
}

const lines = raw.split(/\r?\n/);
const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean);
const errors = [];

if (nonEmptyLines.length === 0) {
  errors.push(`${fileArg} 为空`);
} else {
  const expectedTitle = `## ✨ v${version} 更新内容`;
  const first = nonEmptyLines[0];
  const titleMatch = /^##\s+(?:✨\s+)?v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+更新内容$/.exec(first);
  if (!titleMatch) {
    errors.push(`首行格式应为 "${expectedTitle}"，当前为 "${first}"`);
  } else if (titleMatch[1] !== version) {
    errors.push(
      `更新说明版本号（v${titleMatch[1]}）与 package.json（v${version}）不一致，请更新 ${fileArg}`,
    );
  }
}

const hasSection = nonEmptyLines.some((line) => /^###\s+\S/.test(line));
if (!hasSection) {
  errors.push('至少需要一个 "### <功能分组>" 小节');
}

const hasBullet = nonEmptyLines.some((line) => /^[-*]\s+\S/.test(line));
if (!hasBullet) {
  errors.push('至少需要一条以 "- " 开头的更新条目');
}

const placeholderPatterns = [/【请用一句话概括/, /【待补充】/, /<!--\s*TODO/i];
for (const pattern of placeholderPatterns) {
  if (pattern.test(raw)) {
    errors.push(`检测到未替换的草稿占位符（匹配 ${pattern}），请润色后再发布`);
  }
}

if (errors.length > 0) {
  console.error(`${fileArg} 校验未通过（目标版本 v${version}）：`);
  for (const issue of errors) {
    console.error(`  - ${issue}`);
  }
  process.exit(1);
}

console.log(`${fileArg} 校验通过：v${version}`);
