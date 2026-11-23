// 根据上一版本 tag 到 HEAD 的提交自动归类生成 release-notes.md 草稿。
// 用法：
//   node scripts/draft-release-notes.mjs                 # 打印草稿到 stdout
//   node scripts/draft-release-notes.mjs --write         # 写入 release-notes.md（已存在时拒绝覆盖）
//   node scripts/draft-release-notes.mjs --write --force # 覆盖已有 release-notes.md
//   node scripts/draft-release-notes.mjs --from v0.4.1 --version 0.5.0 --all
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

function git(...argv) {
  return execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
}

let version = option('--version');
if (!version) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  version = pkg.version;
}
if (!version) throw new Error('无法从 package.json 读取版本号');

const currentTag = `v${version}`;
let fromRef = option('--from');
if (!fromRef) {
  const mergedTags = git('tag', '--merged', 'HEAD', '--sort=-v:refname', 'v*')
    .split('\n')
    .map((line) => line.trim())
    .filter((tag) => tag && tag !== currentTag);
  if (mergedTags.length > 0) {
    fromRef = mergedTags[0];
  } else {
    const allTags = git('tag', '--sort=-v:refname', 'v*')
      .split('\n')
      .map((line) => line.trim())
      .filter((tag) => tag && tag !== currentTag);
    fromRef = allTags[0];
  }
}

const range = fromRef ? `${fromRef}..HEAD` : 'HEAD';
const logOutput = git('log', '--no-merges', '--format=%H%x1f%s%x1e', range);

const commits = logOutput
  .split('\x1e')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [hash, subject = ''] = entry.split('\x1f');
    return { hash: hash.trim(), subject: subject.trim() };
  });

const includeAll = hasFlag('--all');

const sectionOrder = [
  { key: 'feat', title: '新功能' },
  { key: 'fix', title: '问题修复' },
  { key: 'perf', title: '性能优化' },
  { key: 'polish', title: '体验与界面优化' },
  { key: 'other', title: '其他变更' },
];

const buckets = new Map(sectionOrder.map((section) => [section.key, []]));
const skipped = [];

// 忽略纯维护/工程噪声提交（可通过 --all 全部输出以便人工挑选）。
const noiseTypes = new Set(['chore', 'ci', 'docs', 'test', 'build', 'wip', 'release']);
const conventionalRe = /^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

for (const commit of commits) {
  const match = conventionalRe.exec(commit.subject);
  if (!match) {
    buckets.get('other').push(commit.subject);
    continue;
  }
  const type = match[1].toLowerCase();
  const scope = match[2]?.trim();
  const breaking = Boolean(match[3]);
  const description = match[4].trim();
  const prefix = `${breaking ? '[破坏性变更] ' : ''}${scope ? `(${scope}) ` : ''}`;
  const line = `${prefix}${description}`;

  if (type === 'feat') {
    buckets.get('feat').push(line);
  } else if (type === 'fix') {
    buckets.get('fix').push(line);
  } else if (type === 'perf') {
    buckets.get('perf').push(line);
  } else if (type === 'style' || type === 'refactor') {
    buckets.get('polish').push(line);
  } else if (noiseTypes.has(type)) {
    if (includeAll) {
      buckets.get('other').push(`[${type}] ${line}`);
    } else {
      skipped.push(commit.subject);
    }
  } else {
    buckets.get('other').push(line);
  }
}

const lines = [`## ✨ ${currentTag} 更新内容`, ''];
if (fromRef) {
  lines.push(`更新基线：在 ${fromRef} 基础上【请用一句话概括本版本核心变化】。`, '');
} else {
  lines.push('更新基线：【请用一句话概括本版本核心变化】。', '');
}

let includedCount = 0;
for (const section of sectionOrder) {
  const items = buckets.get(section.key);
  if (!items || items.length === 0) continue;
  lines.push(`### ${section.title}`, '');
  for (const item of items) {
    lines.push(`- ${item}`);
    includedCount += 1;
  }
  lines.push('');
}

if (includedCount === 0) {
  lines.push('### 更新内容', '', '- 【待补充】', '');
}

const content = `${lines.join('\n').trimEnd()}\n`;

if (hasFlag('--write')) {
  const target = path.join(root, 'release-notes.md');
  if (existsSync(target) && !hasFlag('--force')) {
    console.error('release-notes.md 已存在；如需覆盖请追加 --force。');
    process.exit(1);
  }
  await writeFile(target, content, 'utf8');
  console.error(
    `已写入 release-notes.md（范围 ${range}，收录 ${includedCount} 条，略过 ${skipped.length} 条维护类提交）。\n` +
      '请按用户视角润色分组与描述，再运行 yarn release:notes:check 校验。',
  );
} else {
  process.stdout.write(content);
  console.error(
    `\n[草稿统计] 范围：${range}；收录 ${includedCount} 条，略过 ${skipped.length} 条维护类提交（追加 --all 可查看全部，追加 --write 可写入 release-notes.md）。`,
  );
}
