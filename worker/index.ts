// select-cheap —— 静态资产 + D1 运行时文章层（R254 通用模板实例）
//
// 由 cowork-cloud-tools/scripts/d1_runtime_scaffold.py 从模板生成；
// 模板正本：cowork-cloud-tools/scripts/templates/d1-runtime/worker-index.ts.tmpl
// 参照实现与设计说明：site-builds/course-org-cn/worker/index.ts
//
// 设计原则是**只做加法**：
//   1. 任何请求先走静态资产，已构建页面行为与接入前完全一致，零回归。
//   2. 只有静态资产 404 时，才回落到 D1 查文章。D1 只承载"还没进构建产物"
//      的新文章；URL 集合永远只增不减。
//   3. Worker 绝不改写任何已存在于构建产物里的路径（云构建等价闸按
//      dist manifest 逐文件核 sha256，运行时改写会让 promote 被拒）。
//      对外的 /sitemap.xml 与 /llms.txt 由本 Worker 用静态正本 + D1 现合成。
//
// 渲染走服务端：首屏 HTML 就是完整正文，不依赖前端 JS 二次拉取。
import { HEAD, TAIL } from "./template";

// 2026-08-21 事故防复发（ca-edu-pl）：不用 Fetcher/D1Database 这两个
// Cloudflare 环境的全局环境类型——它们要靠站内装了 @cloudflare/workers-types
// 才存在，本批要接入的站里不是每一个都装了这个包。部分 astro 站的构建脚本
// 带严格类型检查（astro check / tsc --noEmit），缺这个包会直接编译失败，
// 云构建 fail closed（ca-edu-pl 实测踩过，生产未受影响）。
// 这里改成只描述实际用到的方法签名的最小结构类型，不依赖任何外部类型包，
// 对任何站的 TypeScript 环境都成立。
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
}
interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
}
interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  ASSETS: FetcherLike;
  DB: D1DatabaseLike;
}

const ORIGIN = "https://select.cheap";
const SEG = "articles"; // 文章 URL 段（sites.yaml render_url_segment）
const SITEMAP_BASE = "/sitemap-index.xml"; // 构建产物里的 sitemap 静态正本路径
const LLMS_BASE = "/llms-base.txt"; // 构建产物里的 llms 静态正本路径
const SITEMAP_TRAILING = true; // 合成 sitemap loc 是否带尾斜杠
const DATE_STYLE = "iso"; // "zh" | "iso"

const ARTICLE_RE = new RegExp(
  "^/" +
    SEG.split("/")
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("/") +
    "/([A-Za-z0-9][A-Za-z0-9._-]*)/?$",
);

interface ArticleRow {
  slug: string;
  title: string;
  description: string;
  category: string;
  body_html: string;
  published_at: string;
  updated_at: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// "2026-07-08" -> "2026年7月8日"（zh 站与静态文章页的日期写法保持一致）
function cnDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

function renderArticle(a: ArticleRow): string {
  // 模板里 canonical 一律存成不带尾斜杠的 {{CANONICAL}}（带尾斜杠的位置
  // 在切模板时自然保留成 "{{CANONICAL}}/"），这里只填 base 形式即可。
  const canonicalBase = `${ORIGIN}/${SEG}/${a.slug}`;
  const dateIso = (a.published_at || "").slice(0, 10);
  const dateDisplay = DATE_STYLE === "zh" ? cnDate(dateIso) : dateIso;
  const head = HEAD
    .split("{{CANONICAL}}").join(escapeHtml(canonicalBase))
    .split("{{DESC}}").join(escapeHtml(a.description))
    .split("{{TITLE}}").join(escapeHtml(a.title))
    .split("{{DATE_ISO_FULL}}").join(escapeHtml(`${dateIso}T00:00:00Z`))
    .split("{{DATE_ISO}}").join(escapeHtml(dateIso))
    .split("{{DATE}}").join(escapeHtml(dateDisplay))
    .split("{{CATEGORY_SUFFIX}}").join(
      a.category ? `<span> · ${escapeHtml(a.category)}</span>` : "",
    );
  return head + a.body_html + TAIL;
}

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  // 暂不加边缘缓存：先保证"发布即可见"可被无歧义验证（同 course-org-cn）。
  "cache-control": "public, max-age=0, must-revalidate",
};

function escapeXml(s: string): string {
  return escapeHtml(s).replace(/'/g, "&apos;");
}

// 取构建产物里的静态正本
async function fetchBase(env: Env, url: URL, path: string): Promise<string | null> {
  const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin).toString()));
  return res.ok ? await res.text() : null;
}

// 只取索引需要的字段——sitemap/llms 用不到正文，带上 body_html 会随文章
// 数量增长把每次爬虫拉取变成全库正文扫描。
type ArticleIndexRow = Pick<ArticleRow, "slug" | "title" | "published_at" | "updated_at">;

async function listArticles(env: Env): Promise<ArticleIndexRow[]> {
  const res = await env.DB.prepare(
    `SELECT slug, title, published_at, updated_at
       FROM articles WHERE status = 'published' ORDER BY published_at DESC`,
  ).all<ArticleIndexRow>();
  return res.results ?? [];
}

// 正本 + D1 新文章合成 sitemap。正本里已有的 slug 不重复登记（静态优先）。
function composeSitemap(base: string, rows: ArticleIndexRow[]): string {
  const extra = rows
    .filter((r) => !base.includes(`/${SEG}/${r.slug}`))
    .map((r) => {
      const loc = `${ORIGIN}/${SEG}/${r.slug}${SITEMAP_TRAILING ? "/" : ""}`;
      return (
        `<url><loc>${escapeXml(loc)}</loc>` +
        `<lastmod>${escapeXml((r.updated_at || r.published_at).slice(0, 10))}</lastmod></url>`
      );
    });
  if (!extra.length) return base;
  const close = base.lastIndexOf("</urlset>");
  if (close < 0) return base;
  return base.slice(0, close) + extra.join("\n") + "\n" + base.slice(close);
}

// 保留正本里的条目，把 D1 新文章追加在后面。
function composeLlms(base: string, rows: ArticleIndexRow[]): string {
  const extra = rows
    .filter((r) => !base.includes(`/${SEG}/${r.slug}`))
    .map((r) => `- [${r.title}](${ORIGIN}/${SEG}/${r.slug}${SITEMAP_TRAILING ? "/" : ""})`);
  if (!extra.length) return base;
  return base.replace(/\s+$/, "") + "\n" + extra.join("\n") + "\n";
}

async function lookupArticle(env: Env, slug: string): Promise<ArticleRow | null> {
  const row = await env.DB.prepare(
    `SELECT slug, title, description, category, body_html, published_at, updated_at
       FROM articles WHERE slug = ? AND status = 'published'`,
  ).bind(slug).first<ArticleRow>();
  return row ?? null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const assetRes = await env.ASSETS.fetch(request);

    if (request.method !== "GET" && request.method !== "HEAD") return assetRes;

    // 静态资产命中就直接返回；只有 404 才回落 D1
    if (assetRes.status !== 404) return assetRes;

    // /sitemap.xml 与 /llms.txt 刻意不在构建产物里，永远走到这里现合成
    const feed =
      url.pathname === "/sitemap.xml"
        ? { base: SITEMAP_BASE, type: "application/xml; charset=utf-8", compose: composeSitemap }
        : url.pathname === "/llms.txt"
          ? { base: LLMS_BASE, type: "text/plain; charset=utf-8", compose: composeLlms }
          : null;

    if (feed) {
      const base = await fetchBase(env, url, feed.base);
      if (base === null) return assetRes;
      let body = base;
      // D1 出问题时退回静态正本，不要让索引文件跟着挂
      try {
        body = feed.compose(base, await listArticles(env));
      } catch {}
      return new Response(body, {
        headers: { "content-type": feed.type, "cache-control": "public, max-age=0, must-revalidate" },
      });
    }

    const m = ARTICLE_RE.exec(url.pathname);
    if (!m) return assetRes;

    try {
      const article = await lookupArticle(env, m[1]);
      if (!article) return assetRes;
      return new Response(renderArticle(article), { headers: HTML_HEADERS });
    } catch {
      return assetRes;
    }
  },
};
