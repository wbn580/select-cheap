// Cloud-build port of wrangler_deploy._apply_release_manifest_date_metadata.
// Runs inside the site repo after `npm run build`: carries scheduled publication
// dates from release-manifest.json into the built article HTML (meta tags +
// JSON-LD). No-op when the manifest is absent. The workspace-side artifact
// equivalence check (cloud_preview_gates.py, parity_release_date_metadata)
// verifies the OUTCOME of this script against the Python implementation on
// every cloud build — any page this script misses fails promotion closed.
// Template SSOT: cowork-cloud-tools/scripts/templates/cloud-postbuild-dates.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const MANIFEST = 'release-manifest.json';

if (!existsSync(MANIFEST)) process.exit(0);
let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch {
  process.exit(0);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

function resolveSlug(clean) {
  for (const prefix of ['articles', 'posts', 'blog', 'news', '']) {
    const base = prefix ? join(DIST, prefix) : DIST;
    for (const cand of [join(base, clean, 'index.html'), join(base, `${clean}.html`)]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
  }
  const hits = [];
  for (const p of walk(DIST)) {
    if (p.endsWith(join(clean, 'index.html')) || p.endsWith(`${clean}.html`)) hits.push(p);
  }
  return hits.sort()[0] || null;
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

let patched = 0;
for (const article of manifest.articles || []) {
  if (!article || typeof article !== 'object' || article.superseded_by_real_theme_ssot) continue;
  const slug = String(article.slug || '').trim().replace(/^\/+|\/+$/g, '');
  let pub = String(article.publication_datetime || '').trim();
  const releaseDate = String(article.release_date || '').trim();
  if (!pub && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) pub = `${releaseDate}T12:00:00Z`;
  if (!slug || !pub || slug.split('/').includes('..')) continue;
  const htmlPath = resolveSlug(slug);
  if (!htmlPath) continue; // python side reports unresolved; nothing to write here
  let text = readFileSync(htmlPath, 'utf8');
  const mod = String(article.modified_datetime || pub).trim();
  if (text.includes(pub) || text.includes(pub.slice(0, 10))) continue; // already present
  const original = text;

  const pubTag = `<meta property="article:published_time" content="${escAttr(pub)}">`;
  const pubRe = /<meta\s+property=["']article:published_time["'][^>]*>/i;
  text = pubRe.test(text) ? text.replace(pubRe, pubTag)
    : text.replace('</head>', `${pubTag}\n</head>`);

  const modTag = `<meta property="article:modified_time" content="${escAttr(mod)}">`;
  const modRe = /<meta\s+property=["']article:modified_time["'][^>]*>/i;
  text = modRe.test(text) ? text.replace(modRe, modTag)
    : text.replace('</head>', `${modTag}\n</head>`);

  if (/"datePublished"\s*:/.test(text)) {
    text = text.replace(/("datePublished"\s*:\s*)"[^"]*"/g, `$1${JSON.stringify(pub)}`);
    if (/"dateModified"\s*:/.test(text)) {
      text = text.replace(/("dateModified"\s*:\s*)"[^"]*"/g, `$1${JSON.stringify(mod)}`);
    }
  } else {
    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const headline = titleMatch
      ? titleMatch[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
      : slug;
    const schema = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Article', headline,
      datePublished: pub, dateModified: mod,
    });
    text = text.replace('</head>',
      `<script type="application/ld+json">${schema}</script>\n</head>`);
  }

  if (text === original) continue;
  writeFileSync(htmlPath, text, 'utf8');
  patched += 1;
}
console.log(`[cloud-postbuild-dates] patched ${patched} page(s)`);
