# 本地开发

要求 Bun 1.3.14、Node.js 22。仓库采用 TypeScript workspace。

```sh
git clone https://github.com/idoknow/botroost.git
cd botroost
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

数据库相关集成测试需要按测试配置准备 PostgreSQL。不要使用生产数据库跑测试。

## 文档开发

```sh
bun run docs:dev
bun run docs:build
```

文档源文件在 docs/site，站点配置在 docs/.vitepress。Cloudflare Workers static assets 从构建目录发布，配置在 wrangler.jsonc。

```sh
bun run docs:deploy
```

部署凭据由环境变量 CLOUDFLARE_API_TOKEN 提供，不提交到仓库。部署后同时核验 workers.dev 和自定义域名的实际内容。
