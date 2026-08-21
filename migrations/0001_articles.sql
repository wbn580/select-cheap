-- select-cheap 运行时文章表（R254，模板正本：
-- cowork-cloud-tools/scripts/templates/d1-runtime/0001_articles.sql.tmpl）
--
-- 只承载"还没进构建产物"的新文章：Worker 先走静态资产，404 才查这里。
-- 静态正本里已有的文章不需要也不应该重复写进来（见 worker/index.ts 文件头）。
--
-- body_html 存已渲染好的正文 HTML 片段（对应静态页正文容器的内层），
-- 不含站点外壳；外壳由 worker/template.ts 从真实构建产物切出，两边长相一致。
CREATE TABLE IF NOT EXISTS articles (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '',
  body_html    TEXT NOT NULL,
  published_at TEXT NOT NULL,                    -- YYYY-MM-DD
  updated_at   TEXT NOT NULL,                    -- YYYY-MM-DD
  status       TEXT NOT NULL DEFAULT 'published' -- published | draft
);

CREATE INDEX IF NOT EXISTS idx_articles_status_published_at
  ON articles (status, published_at DESC);
