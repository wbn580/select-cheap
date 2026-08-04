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
