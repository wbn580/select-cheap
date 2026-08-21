// 从一篇已构建好的静态文章页反推出运行时渲染模板（worker/template.ts）。
//
// 由 d1_runtime_scaffold.py 从模板生成；模板正本：
// cowork-cloud-tools/scripts/templates/d1-runtime/gen-article-template.mjs.tmpl
// 参照实现：site-builds/course-org-cn/scripts/gen-article-template.mjs
//
// 站点外壳（head/meta/nav/footer）由构建产出，手抄一份到 Worker 里迟早跑偏。
// 这里以真实产物为唯一正本切出 HEAD/TAIL 两段，中间留占位符，运行时只把
// D1 里的字段填进去 —— 动态文章和静态文章长得一模一样。
//
// 外壳改版后重跑本脚本即可：node scripts/gen-article-template.mjs
// 任何一步定位/替换失败都直接 throw（fail closed），绝不硬切。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const REF = "dist/articles/select-cheap-0910/index.html"; // 参考页（已构建产物里的一篇真实文章页）
const SEG = "articles";
const DEFAULT_OG = "https://select.cheap/og-image.jpg"; // 站点默认 og 图（绝对 URL，可为空串）
const OUT = "worker/template.ts";

const html = readFileSync(REF, "utf8");

// ── 1. 从参考页自提取元数据（不手抄，保证与产物一致） ──────────────
function extractCanonical(h) {
  const m =
    /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(h) ||
    /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i.exec(h);
  if (!m) throw new Error("参考页找不到 canonical");
  return m[1];
}
function extractDesc(h) {
  const m =
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(h) ||
    /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i.exec(h);
  if (!m) throw new Error("参考页找不到 meta description");
  return m[1];
}
function extractTitle(h) {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(h);
  if (!m) throw new Error("参考页找不到 <h1>");
  const text = m[1].replace(/<[^>]+>/g, "").trim();
  if (!text) throw new Error("参考页 <h1> 为空");
  return text;
}
function extractDateIso(h) {
  let m = /<meta[^>]*property=["']article:published_time["'][^>]*content=["'](\d{4}-\d{2}-\d{2})/i.exec(h);
  if (m) return m[1];
  m = /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(h);
  if (m) return m[1];
  m = /<div class="text-sm mb-3"[^>]*>\s*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(h);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  return "";
}

const REF_CANONICAL = extractCanonical(html);
const REF_TITLE = extractTitle(html);
const REF_DESC = extractDesc(html);
const REF_DATE_ISO = extractDateIso(html);
const CANONICAL_BASE = REF_CANONICAL.replace(/\/+$/, "");
const REF_SLUG = CANONICAL_BASE.split("/").pop();
if (!REF_SLUG) throw new Error(`canonical 解析不出 slug：${REF_CANONICAL}`);

// ── 2. 定位正文容器（优先 prose，其次 <article>，再次 <main>） ─────
// 返回 [容器开标签结束位置, 容器闭标签开始位置]，闭标签用同名标签深度扫描配对。
function matchClose(h, tagName, fromIdx) {
  const re = new RegExp(`<${tagName}\\b|</${tagName}>`, "gi");
  re.lastIndex = fromIdx;
  let depth = 1;
  let m;
  while ((m = re.exec(h)) !== null) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return m.index;
    } else {
      depth += 1;
    }
  }
  throw new Error(`容器 <${tagName}> 找不到配对的闭标签`);
}

function locateContainer(h) {
  const proseAttr = h.indexOf('class="prose');
  if (proseAttr >= 0) {
    const tagStart = h.lastIndexOf("<", proseAttr);
    const tagName = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(h.slice(tagStart))?.[1];
    if (!tagName) throw new Error("prose 容器开标签解析失败");
    const openEnd = h.indexOf(">", proseAttr) + 1;
    if (openEnd <= 0) throw new Error("prose 容器开标签未闭合");
    return { openEnd, closeStart: matchClose(h, tagName, openEnd), via: "prose" };
  }
  for (const tagName of ["article", "main"]) {
    const i = h.search(new RegExp(`<${tagName}\\b`, "i"));
    if (i < 0) continue;
    const openEnd = h.indexOf(">", i) + 1;
    if (openEnd <= 0) continue;
    return { openEnd, closeStart: matchClose(h, tagName, openEnd), via: tagName };
  }
  throw new Error("参考页找不到正文容器（prose/<article>/<main> 都没有）");
}

const { openEnd, closeStart, via } = locateContainer(html);
if (!(openEnd < closeStart)) throw new Error("正文边界推断失败");

// 容器一开头如果就是 <h1>（简单模板家族：标题在容器内），把它并进 HEAD，
// 因为 body_html 与 course-org-cn 一致约定不含 <h1>。
let bodyStart = openEnd;
const afterOpen = html.slice(openEnd);
const wsLen = afterOpen.length - afterOpen.replace(/^\s+/, "").length;
if (/^<h1\b/i.test(afterOpen.slice(wsLen))) {
  const h1Close = html.indexOf("</h1>", openEnd);
  if (h1Close < 0) throw new Error("容器内 <h1> 未闭合");
  bodyStart = h1Close + "</h1>".length;
}

let head = html.slice(0, bodyStart);
const tail = html.slice(closeStart);

// ── 3. 占位符替换（顺序敏感：长串先替换，避免子串误伤） ────────────
// canonical：带尾斜杠的实例先替换成 "{{CANONICAL}}/"，这样原页面的
// 尾斜杠习惯被逐字保留，Worker 只需要填不带尾斜杠的 base。
head = head.split(CANONICAL_BASE + "/").join("{{CANONICAL}}/");
head = head.split(CANONICAL_BASE).join("{{CANONICAL}}");

for (const s of [REF_TITLE, REF_DESC].sort((a, b) => b.length - a.length)) {
  head = head.split(s).join(s === REF_TITLE ? "{{TITLE}}" : "{{DESC}}");
}

// og:image / twitter:image 指向按 slug 生成的配图时，运行时文章没有对应
// 产物，换成站点默认图；没有默认图则 fail closed（绝不让所有动态文章
// 顶着参考文章的配图上线）。
if (head.includes(REF_SLUG)) {
  head = head.replace(
    /(<meta[^>]*(?:property=["']og:image["']|name=["']twitter:image["'])[^>]*content=["'])([^"']*)(["'])/gi,
    (all, pre, url, post) => {
      if (!url.includes(REF_SLUG)) return all;
      if (!DEFAULT_OG) throw new Error(`og:image 按 slug 生成（${url}）但站点没有默认 og 图`);
      return pre + DEFAULT_OG + post;
    },
  );
}

// 日期：JSON-LD → meta → 可见文本，全部换成占位符
head = head
  .replace(/("datePublished"\s*:\s*")[^"]+(")/g, "$1{{DATE_ISO_FULL}}$2")
  .replace(/("dateModified"\s*:\s*")[^"]+(")/g, "$1{{DATE_ISO_FULL}}$2");
if (REF_DATE_ISO) {
  const [y, mo, d] = REF_DATE_ISO.split("-").map(Number);
  head = head
    .split(`${REF_DATE_ISO}T`).join("{{DATE_ISO}}T")   // 残余 datetime 前缀
    .split(REF_DATE_ISO).join("{{DATE_ISO}}")
    .split(`${y}年${mo}月${d}日`).join("{{DATE}}");
  // "{{DATE_ISO}}T..." 这种残余 datetime 统一收敛成 DATE_ISO_FULL
  head = head.replace(/\{\{DATE_ISO\}\}T[0-9:.]+Z?/g, "{{DATE_ISO_FULL}}");
}

// course/stays 家族的日期+分类行：整行换成 {{DATE}}{{CATEGORY_SUFFIX}}
head = head.replace(
  /(<div class="text-sm mb-3"[^>]*>)[\s\S]*?(<\/div>)/,
  "$1{{DATE}}{{CATEGORY_SUFFIX}}$2",
);

// ── 4. 验收（fail closed） ─────────────────────────────────────────
for (const token of ["{{CANONICAL}}", "{{TITLE}}", "{{DESC}}"]) {
  if (!head.includes(token)) throw new Error(`占位符 ${token} 缺失——参考页可能已改版`);
}
if (head.includes(REF_SLUG)) {
  throw new Error(`HEAD 里仍残留参考文章 slug（${REF_SLUG}），模板会把所有动态文章指向它`);
}
if (REF_DATE_ISO && head.includes(REF_DATE_ISO)) {
  throw new Error(`HEAD 里仍残留参考文章日期 ${REF_DATE_ISO}`);
}
if (!/\{\{DATE(_ISO(_FULL)?)?\}\}/.test(head)) {
  console.warn("⚠ 模板里没有任何日期占位符（参考页本身不展示日期），动态文章将不显示日期");
}

mkdirSync("worker", { recursive: true });
writeFileSync(
  OUT,
  `// 本文件由 scripts/gen-article-template.mjs 从 ${REF} 生成（容器定位：${via}），请勿手改。
// 站点外壳改版后重跑该脚本，让动态文章页跟静态页保持一致。
export const HEAD = ${JSON.stringify(head)};

export const TAIL = ${JSON.stringify(tail)};
`,
  "utf8",
);

console.log(
  `ok: ${OUT} (via=${via}, head ${head.length}B, tail ${tail.length}B, seg=/${SEG}/, ref=${REF_SLUG})`,
);
