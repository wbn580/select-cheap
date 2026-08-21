// [d1-runtime-gate] R254 运行时渲染站构建闸（勿删；由 d1_runtime_scaffold.py 注入）
// sitemap.xml 与 llms.txt 由 Worker 在运行时用 *-base 正本 + D1 新文章合成，
// 因此**不能**作为构建产物存在：云构建等价闸会对 dist 里每个文件逐字节核 sha256，
// 一旦它们进了 dist，要么被静态直出（新文章消失），要么哈希对不上（部署被拒）。
// 往这两个文件追加内容的脚本（如 Data2Web 批次的 add_sitemap_url / add_llms_line）
// 请改写 public/sitemap-base.xml 与 public/llms-base.txt。
{
  const { existsSync: __d1rtExists } = await import('node:fs');
  for (const [bad, good] of [
    ['public/sitemap.xml', 'public/sitemap-base.xml'],
    ['public/llms.txt', 'public/llms-base.txt'],
  ]) {
    if (__d1rtExists(bad)) {
      console.error(`\n❌ ${bad} 不应存在——它会盖掉 Worker 运行时合成的版本，让新文章从索引里消失。`);
      console.error(`   请把内容并进 ${good} 后删除 ${bad}。详见站内 AGENTS.md。\n`);
      process.exit(1);
    }
  }
}
// [/d1-runtime-gate]

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
for (const name of await readdir('.')) {
  if (/^[A-Za-z0-9_-]{8,128}\.txt$/.test(name)) await cp(name, `dist/${name}`);
}
async function addCanonicals(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) await addCanonicals(file);
    else if (entry.name.endsWith('.html')) {
      const html = await readFile(file, 'utf8');
      if (!/rel=["']canonical["']/.test(html)) {
        const route = relative('dist', file).replace(/index\.html$/, '').replace(/\.html$/, '');
        const canonical = new URL(`/${route}`, 'https://select.cheap').toString();
        await writeFile(file, html.replace('<head>', `<head><link rel="canonical" href="${canonical}">`));
      }
    }
  }
}
await addCanonicals('dist');
