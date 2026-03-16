# NekoAI

一个部署在 Cloudflare 上的极简网页聊天工具：

- OpenAI 兼容接口
- 单访问密钥鉴权
- 动态读取 `/v1/models`
- 本地浏览器保存聊天记录
- 不依赖数据库
- 前后端分离：**Pages 前端 + Workers API**

## 项目结构

- `src/index.js`：Cloudflare Worker API
- `public/`：Cloudflare Pages 前端静态文件
- `public/config.js`：前端 API 地址配置
- `wrangler.toml`：Workers API 配置
- `.dev.vars.example`：本地开发环境变量示例

## 需要的环境变量

Workers API 需要：

- `OPENAI_BASE_URL`：你的 OpenAI 兼容接口地址（不要带 `/v1/models`）
- `OPENAI_API_KEY`：上游 API Key
- `ACCESS_KEY`：给朋友使用的共享访问密钥
- `ALLOWED_ORIGIN`：允许访问 API 的前端站点域名（可选）

例如：

```env
OPENAI_BASE_URL="https://api.example.com"
OPENAI_API_KEY="sk-xxxx"
ACCESS_KEY="nekoai-2026"
ALLOWED_ORIGIN="https://nekoai.pages.dev"
```

## 本地运行 API

先安装依赖：

```bash
npm install
cp .dev.vars.example .dev.vars
```

然后启动 Worker API：

```bash
npm run dev
```

## 部署方式

### 1. 部署 Workers API

先登录 Wrangler：

```bash
npx wrangler login
```

设置线上 secrets：

```bash
npx wrangler secret put OPENAI_BASE_URL
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ACCESS_KEY
npx wrangler secret put ALLOWED_ORIGIN
```

部署：

```bash
npm run deploy
```

默认 Worker 名称：
- `nekoai-api`

默认地址类似：
- `https://nekoai-api.your-subdomain.workers.dev`

### 2. 部署 Pages 前端

把 `public/` 目录作为静态站点部署到 Cloudflare Pages。

在正式部署前，修改：

- `public/config.js`

把里面的：

```js
window.NEKOAI_CONFIG = {
  API_BASE_URL: "https://nekoai-api.your-subdomain.workers.dev"
};
```

改成你自己的 Workers API 地址。

## 当前接口

### `GET /api/models`
- 需要 `Authorization: Bearer <ACCESS_KEY>`
- Worker 代理上游 `/v1/models`
- 不做 fallback

### `POST /api/chat`
- 需要 `Authorization: Bearer <ACCESS_KEY>`
- 代理上游 `/v1/chat/completions`
- 支持流式返回

## 当前实现说明

这是一个最简可跑版本，特点是：

- 不接数据库
- 不做用户系统
- 不做聊天记录云端同步
- 模型列表不写死
- 上游失败就直接报错
- 前端和 API 分离部署

## 后续可以继续加的东西

- Markdown 渲染
- 代码高亮
- 删除会话
- 导出会话
- IP 限流
- 模型过滤
- 自定义系统提示词
- 自定义域名
