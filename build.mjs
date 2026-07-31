import { cp, mkdir, readdir, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
for (const name of await readdir('.')) {
  if (/^[A-Za-z0-9_-]{8,128}\.txt$/.test(name)) await cp(name, `dist/${name}`);
}
