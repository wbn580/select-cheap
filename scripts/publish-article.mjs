// 把一篇文章写进 D1，立即上线，不经过 build & deploy。
//
// 由 d1_runtime_scaffold.py 从模板生成；模板正本：
// cowork-cloud-tools/scripts/templates/d1-runtime/publish-article.mjs.tmpl
// 参照实现：site-builds/course-org-cn/scripts/publish-article.mjs
//
//   node scripts/publish-article.mjs <article.json>            # 写线上库
//   node scripts/publish-article.mjs <article.json> --local    # 写本地库（调试用）
//   node scripts/publish-article.mjs <article.json> --dry-run  # 只打印 SQL
//
// article.json 字段：
//   slug          必填，URL 片段，落在 /articles/<slug>/
//   title         必填
//   body_html     必填，正文 HTML 片段（不含站点外壳，外壳由 Worker 套）
//   description   建议填，进 meta description / og:description
//   category      可选，留空则不显示
//   published_at  可选，YYYY-MM-DD，默认今天
//   status        可选，published（默认）| draft，draft 不对外可见
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DB = "select-cheap-content";
const ORIGIN = "https://select.cheap";
const SEG = "articles";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const local = args.includes("--local");
const dryRun = args.includes("--dry-run");

if (!file) {
  console.error("用法: node scripts/publish-article.mjs <article.json> [--local] [--dry-run]");
  process.exit(2);
}

const a = JSON.parse(readFileSync(file, "utf8"));

for (const k of ["slug", "title", "body_html"]) {
  if (!a[k] || typeof a[k] !== "string" || !a[k].trim()) {
    console.error(`字段 ${k} 必填且不能为空`);
    process.exit(2);
  }
}
// slug 直接进 URL，也进 Worker 的路由正则，收紧到和正则一致的字符集
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.slug)) {
  console.error(`slug 只能是字母数字和 . _ -，且以字母数字开头：${a.slug}`);
  process.exit(2);
}
// 用北京时间而不是 UTC：中文站傍晚发的文章按 UTC 算会显示成前一天。
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const published_at = a.published_at || today;
if (!/^\d{4}-\d{2}-\d{2}$/.test(published_at)) {
  console.error(`published_at 必须是 YYYY-MM-DD：${published_at}`);
  process.exit(2);
}
const status = a.status || "published";
if (!["published", "draft"].includes(status)) {
  console.error(`status 只能是 published 或 draft：${status}`);
  process.exit(2);
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql =
  `INSERT INTO articles (slug, title, description, category, body_html, published_at, updated_at, status)
   VALUES (${q(a.slug)}, ${q(a.title)}, ${q(a.description || "")}, ${q(a.category || "")},
           ${q(a.body_html)}, ${q(published_at)}, ${q(today)}, ${q(status)})
   ON CONFLICT(slug) DO UPDATE SET
     title=excluded.title, description=excluded.description, category=excluded.category,
     body_html=excluded.body_html, published_at=excluded.published_at,
     updated_at=excluded.updated_at, status=excluded.status;`;

if (dryRun) {
  console.log(sql);
  process.exit(0);
}

execFileSync(
  "npx",
  ["wrangler", "d1", "execute", DB, local ? "--local" : "--remote", "--command", sql, "-y"],
  { stdio: "inherit", env: { ...process.env, WRANGLER_HTTP_PROXY: "direct" } },
);

console.log(`\n✅ ${a.slug} 已${status === "draft" ? "存为草稿" : "发布"}`);
if (status === "published" && !local) {
  console.log(`   ${ORIGIN}/${SEG}/${a.slug}/`);
  console.log(`   已自动进入 /sitemap.xml 与 /llms.txt（Worker 实时合成，无需部署）`);
}
