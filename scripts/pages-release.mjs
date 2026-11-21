// 从 GitHub Releases 生成发布页使用的 latest.json / releases.json。
// 参照 MusicDan 的 pages-release.mjs，按 BioCN 的多平台安装包做了改编：
// 每个 Release 收录 Android APK 与 Windows/macOS/Linux 桌面安装包，按扩展名分类平台。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const output = option('--output') ?? 'website/dist';
const tag = option('--tag');
const repo = process.env.GITHUB_REPOSITORY ?? 'asinkLuno/BioCN';
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) throw new Error('缺少 GH_TOKEN 或 GITHUB_TOKEN');

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'BioCN-release-metadata',
};

// 平台 → 安装包扩展名；页面下载按钮按 platformOrder 的顺序展示。
const platformOrder = ['android', 'windows', 'macos', 'linux'];
const extensions = {
  android: ['.apk'],
  windows: ['.exe', '.msi'],
  macos: ['.dmg'],
  linux: ['.deb', '.rpm'],
};

// 平台 → 缺少 asset.digest 时的回验来源：APK 有同名 .sha256，
// 桌面安装包只有 CI 上传的 checksums-<label>.sha256 清单。
const checksumManifests = {
  android: (name) => `${name}.sha256`,
  windows: () => 'checksums-windows.sha256',
  macos: () => 'checksums-macos.sha256',
  linux: () => 'checksums-linux.sha256',
};

function classify(name) {
  for (const platform of platformOrder) {
    if (extensions[platform].some((extension) => name.endsWith(extension))) return platform;
  }
  return undefined;
}

// 清单行兼容两种格式：Linux `<hash>  <name>` 与 Windows 的二进制模式
// `<hash> *<name>`（release.yml 的摘要回验也剥过同一个星号）。
function parseChecksums(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match) map.set(match[2].trim(), match[1]);
  }
  return map;
}

async function github(pathname) {
  const response = await fetch(`https://api.github.com/repos/${repo}${pathname}`, { headers });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function checksum(release, asset, platform) {
  if (typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    return asset.digest.slice(7);
  }
  const source = checksumManifests[platform](asset.name);
  const file = release.assets.find((candidate) => candidate.name === source);
  if (!file) throw new Error(`Release ${release.tag_name} 缺少 ${asset.name} 的摘要来源 ${source}`);
  const response = await fetch(file.browser_download_url, { headers });
  if (!response.ok) throw new Error(`无法下载校验文件 ${file.name}: ${response.status}`);
  const match = parseChecksums(await response.text()).get(asset.name);
  if (!match) throw new Error(`校验文件 ${file.name} 里找不到 ${asset.name}`);
  return match;
}

const releases = await github('/releases?per_page=100');
const entries = [];
for (const release of releases) {
  if (release.draft || release.prerelease) continue;
  const downloads = [];
  for (const asset of release.assets) {
    if (asset.state !== 'uploaded') continue;
    const platform = classify(asset.name);
    if (!platform) continue;
    if (!asset.browser_download_url.startsWith('https://github.com/')) continue;
    downloads.push({
      name: asset.name,
      platform,
      size: asset.size,
      sha256: await checksum(release, asset, platform),
      download_url: asset.browser_download_url,
    });
  }
  // 平台顺序稳定；平台内按扩展名优先级排（Windows 的 NSIS .exe 是主按钮，
  // Linux 的 deb 排最前）。localeCompare 对 -/_ 的排序不按字节，不能用来定主按钮。
  downloads.sort(
    (a, b) =>
      platformOrder.indexOf(a.platform) - platformOrder.indexOf(b.platform) ||
      extensions[a.platform].findIndex((extension) => a.name.endsWith(extension)) -
        extensions[b.platform].findIndex((extension) => b.name.endsWith(extension)) ||
      a.name.localeCompare(b.name),
  );
  const version = downloads[0]?.name.match(/^BioCN[_-](\d+\.\d+\.\d+)/)?.[1];
  if (!downloads.length || !version) continue;
  entries.push({
    version,
    published_at: release.published_at,
    notes: release.body ?? '',
    downloads,
  });
}
if (!entries.length) throw new Error('没有可用的 GitHub Release 安装包');
entries.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
const latest = tag ? entries.find((entry) => `v${entry.version}` === tag) : entries[0];
if (!latest) throw new Error(`找不到标签 ${tag} 对应的发布`);

await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
await writeFile(path.join(output, 'releases.json'), `${JSON.stringify(entries, null, 2)}\n`);
console.log(
  `Wrote ${entries.length} release(s) to ${output}; latest v${latest.version} ` +
    `(${latest.downloads.length} files)`,
);
