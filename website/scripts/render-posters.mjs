#!/usr/bin/env node
/**
 * 启动本地 Vite 开发服务器访问 /posters.html?poster=1..3，
 * 调用系统 Chrome 无头渲染 3 张 3:4 高清 PNG（1800×2400 @2x）到 design/posters/。
 *
 * 用法（在 website/ 目录下）：yarn posters:render
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'vite';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(WEBSITE_ROOT, '../design/posters');

const POSTERS = [
  { id: '1', file: '01-cover.png' },
  { id: '2', file: '02-why-biocn.png' },
  { id: '3', file: '03-benchmark-download.png' },
];

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('未找到 Chrome/Chromium 可执行文件，请通过 CHROME_BIN 指定路径。');
}

const chrome = findChrome();
fs.mkdirSync(OUT_DIR, { recursive: true });

const server = await createServer({
  root: WEBSITE_ROOT,
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();

const addr = server.httpServer?.address();
if (!addr || typeof addr === 'string') {
  await server.close();
  throw new Error('无法获取 Vite 开发服务器端口');
}

const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'biocn-posters-chrome-'));

try {
  for (const { id, file } of POSTERS) {
    const outPath = path.join(OUT_DIR, file);
    const url = `http://127.0.0.1:${addr.port}/posters.html?poster=${id}`;
    await execFileAsync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--disable-default-apps',
        '--hide-scrollbars',
        `--user-data-dir=${tmpProfile}`,
        '--force-device-scale-factor=2',
        '--window-size=900,1200',
        '--virtual-time-budget=2000',
        `--screenshot=${outPath}`,
        url,
      ],
      { timeout: 30000 },
    );
    const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(0);
    console.log(`Rendered ${path.relative(path.resolve(WEBSITE_ROOT, '..'), outPath)} (${sizeKB} KB)`);
  }
} finally {
  await server.close();
  fs.rmSync(tmpProfile, { recursive: true, force: true });
}
