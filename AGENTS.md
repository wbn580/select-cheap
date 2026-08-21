# select-cheap — 本站 agent 须知

## D1 运行时文章层（R254）

本站已由 d1_runtime_scaffold 接入 D1 运行时渲染（参照 course-org-cn，
完整设计与三条硬约束见 site-builds/course-org-cn/AGENTS.md，此处不复述正文）：

- 发文走 `node scripts/publish-article.mjs <article.json>`，写进 D1
  `select-cheap-content` 即刻上线（/articles/<slug>/），不需要构建部署。
- **Worker 绝不改写任何构建产物路径**（云构建等价闸按 dist manifest 核 sha256）。
- 对外 /sitemap.xml 与 /llms.txt 由 Worker 用静态正本（sitemap-index.xml /
  llms-base.txt）+ D1 现合成；往索引文件追加内容的脚本必须写 *-base 正本，
  写回旧名会被构建闸当场拦下。
- 站点外壳改版后重跑 `node scripts/gen-article-template.mjs` 再手动
  `wrangler_deploy.py --sites select-cheap`。
