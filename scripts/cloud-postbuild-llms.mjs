// Cloud-build port of wrangler_deploy._merge_public_llms_overlays.
// Several Astro sites generate a comprehensive dist/llms.txt at the end of the
// build, overwriting the curated public/llms.txt that Data2Web deliberately
// added. The public file is an approved overlay, so append it to the generated
// artifact (including locale subpaths) after the build. No-op when the overlay
// is already contained in the generated file.
// The workspace-side artifact equivalence check (cloud_preview_gates.py,
// parity_public_llms_overlays) verifies this script's OUTCOME against the
// Python implementation on every cloud build.
// Template SSOT: cowork-cloud-tools/scripts/templates/cloud-postbuild-llms.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const PUBLIC = 'public';
const DIST = 'dist';

if (!existsSync(PUBLIC) || !statSync(PUBLIC).isDirectory()) process.exit(0);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

let merged = 0;
for (const overlayPath of walk(PUBLIC)) {
  if (!overlayPath.endsWith('llms.txt')) continue;
  const rel = relative(PUBLIC, overlayPath);
  const target = join(DIST, rel);
  const overlayText = readFileSync(overlayPath, 'utf8').trim();
  if (!overlayText) continue;
  mkdirSync(dirname(target), { recursive: true });
  const generated = existsSync(target)
    ? readFileSync(target, 'utf8').replace(/\s+$/, '')
    : '';
  if (generated.includes(overlayText)) continue;
  writeFileSync(target, generated + (generated ? '\n\n' : '') + overlayText + '\n', 'utf8');
  merged += 1;
}
console.log(`[cloud-postbuild-llms] merged ${merged} overlay(s)`);
