# NekoAI

一个部署在 Cloudflare 上的极简网页聊天工具：

- OpenAI 兼容接口
- 单访问密钥鉴权
- 动态读取 `/v1/models`
- 本地浏览器保存聊天记录
- 不依赖数据库
- 前后端分离：**Pages 前端 + Workers API**
- 默认开启 Exa 联网搜索，并展示「思考与工具调用」过程

## 项目结构

- `src/index.js`：Cloudflare Worker API
- `public/`：Cloudflare Pages 前端静态文件
- `public/config.js`：前端 API 地址配置（本地文件，已 gitignore，参考 `public/config.example.js`）
- `wrangler.jsonc`：Workers API 配置（本地文件，已 gitignore，参考 `wrangler.jsonc.example`）
- `.dev.vars.example`：本地开发环境变量示例

## 需要的环境变量

Workers API 需要：

- `OPENAI_BASE_URL`：你的 OpenAI 兼容接口地址（不要带 `/v1/models`）
- `OPENAI_API_KEY`：上游 API Key
- `ACCESS_KEY`：给朋友使用的共享访问密钥
- `ALLOWED_ORIGIN`：允许访问 API 的前端站点域名（可选）
- `MAX_TOKENS`：单次回复最大 token（可选，默认 4096）
- `EXA_BASE_URL`：Exa 搜索接口地址（可选，默认 `https://api.exa.ai`）
- `EXA_API_KEY`：Exa API Key（配置后自动启用联网搜索；未配置则静默跳过）
- `EXA_SEARCH_PATH`：Exa 搜索路径（可选，默认 `/search`）

例如：

```env
OPENAI_BASE_URL="https://api.example.com"
OPENAI_API_KEY="sk-xxxx"
ACCESS_KEY="nekoai-2026"
ALLOWED_ORIGIN="https://nekoai.pages.dev"
MAX_TOKENS="4096"
EXA_BASE_URL="https://api.exa.ai"
EXA_API_KEY="exa-xxxx"
EXA_SEARCH_PATH="/search"
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
cp wrangler.jsonc.example wrangler.jsonc
```

设置线上 secrets：

```bash
npx wrangler secret put OPENAI_BASE_URL
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ACCESS_KEY
npx wrangler secret put ALLOWED_ORIGIN
npx wrangler secret put EXA_API_KEY
```

非敏感变量（如 `EXA_BASE_URL`、`EXA_SEARCH_PATH`、`MAX_TOKENS`）可以写在 `wrangler.jsonc` 的 `vars` 字段里：
```jsonc
{
  "vars": {
    "EXA_BASE_URL": "https://api.exa.ai",
    "EXA_SEARCH_PATH": "/search",
    "MAX_TOKENS": "4096"
  }
}
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

在正式部署前，复制并修改：

```bash
cp public/config.example.js public/config.js
```

或者直接创建 `public/config.js`。

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
- 返回前按模型 ID 做自然排序，因此每次打开顺序固定
- 不做 fallback

### `POST /api/chat`
- 需要 `Authorization: Bearer <ACCESS_KEY>`
- 代理上游 `/v1/chat/completions`
- 支持流式返回
- `max_tokens` 由服务端 `MAX_TOKENS` 控制

### `POST /api/search`
- 需要 `Authorization: Bearer <ACCESS_KEY>`
- 调用后端配置的 Exa 接口（`EXA_BASE_URL` + `EXA_API_KEY`）
- 请求体：`{ "query": "关键词", "numResults": 5, "type": "auto" }`
- 返回：`{ "query": "...", "results": [{ "title", "url", "text", ... }] }`
- URL / API Key 完全由 Cloudflare 后端环境变量控制，前端不保存任何 Exa 凭据

### `POST /api/fetch`
- 需要 `Authorization: Bearer <ACCESS_KEY>`
- 调用后端配置的 Exa `contents` 接口抓取网页正文
- 请求体：`{ "url": "https://...", "maxCharacters": 4000 }`
- 返回：`{ "url", "title", "publishedDate", "text" }`

### `POST /api/convert`
- 需要 `Authorization: Bearer <ACCESS_KEY>`
- `multipart/form-data`，字段名 `files`（可多个）
- 调用 Cloudflare Workers AI 的 `env.AI.toMarkdown` 把文档转成 Markdown
- 支持：PDF、docx、xlsx/xls/xlsm/xlsb、csv、ods、odt、numbers、html、xml
- 返回：`{ "results": [{ "name", "format", "tokens", "data", "error" }] }`
- 需要在 Wrangler 配置里绑定 Workers AI（见下）

## 附件处理

不同类型的附件走不同链路，尽量把内容转成文本喂给模型：

| 类型 | 处理方式 |
| --- | --- |
| 图片 | 直接以 base64 data URL 传给视觉模型 |
| PDF | 优先 Workers AI `toMarkdown`；失败则前端 pdf.js 抽文本 |
| docx | 前端 mammoth 抽正文 |
| xlsx / xls | 前端 SheetJS 转 CSV |
| pptx | 前端 JSZip 解包，按页抽幻灯片文本 |
| zip / apk / epub 等 | 前端 JSZip 解包，展开其中文本文件（含预算截断） |
| ods / odt / numbers 等 | Workers AI `toMarkdown` |
| 纯文本 / 代码 | 直接读文本注入 |

若某文件既无法云端转换、也无法本地解析，会在附件卡片上标记「解析失败」，
并把原因一并告诉模型，而不是静默丢弃。

Workers AI 绑定（`wrangler.jsonc`）：

```jsonc
{
  "ai": { "binding": "AI" }
}
```

> `wrangler.jsonc` 已加入 `.gitignore`，仓库里只保留 `wrangler.jsonc.example`，
> 避免把自己的账号名 / 自定义域名提交上去。

## 联网搜索（原生工具调用）

联网搜索默认开启，走的是**原生 function calling**，而不是把结果硬塞进 system prompt：

1. 发送消息时会先做一次兜底搜索，把结果作为参考资料注入，保证即使模型不会用工具也有实时信息；
2. 同时把 `web_search` / `web_fetch` 两个工具声明发给模型；
3. 模型返回 `tool_calls` 时，前端真的去执行（搜索走 Exa，抓页面走 Exa contents），
   把结果作为 `role: "tool"` 回灌，循环直到模型给出文字结论；
4. 有预算保护：最多 4 轮、每轮 2 个调用、整条消息最多 4 次搜索 + 4 次抓取；
   相同查询词与相同 URL 会自动去重，避免反复搜索同一内容；
5. 达到轮次上限会用 `tool_choice: "none"` 强制模型收尾。

这样做解决了「只有部分模型能搜索」的问题——不会调用工具的模型也能靠兜底搜索作答，
会调用工具的模型则能看到真实的工具调用过程。个别模型会把
`<tool_call>{...}</tool_call>` 写进正文，前端会自动剥离并归类到折叠块里。

### 思考过程折叠块

搜索、抓取、模型思考会合并成一个「Chain of Thought」折叠块（参考 rikkahub）：

- 默认折叠、点击展开；折叠行有 ✦ 图标、流式时轻微旋转 + 文字微光动画
- 展开后按步骤展示：联网搜索（查询词 + 来源列表）、抓取网页、模型思考（Markdown）
- 流式思考时左侧步骤逐条追加，支持 `reasoning_content` / `reasoning` / 思考标签三种来源

要启用联网搜索，在 Cloudflare Worker 配置这些变量：

- `EXA_API_KEY`（secret，必填）
- `EXA_BASE_URL`（可选，默认 `https://api.exa.ai`）
- `EXA_SEARCH_PATH`（可选，默认 `/search`）
- `EXA_CONTENTS_PATH`（可选，默认 `/contents`）

## 当前实现说明

这是一个极简但可用的版本，特点是：

- 不接数据库
- 不做用户系统
- 不做聊天记录云端同步
- 模型列表不写死
- 前端和 API 分离部署
- 支持 Markdown 渲染、代码复制、停止生成、重新生成、导出会话
- 支持图片 / PDF / Office / 压缩包 / 代码等附件（云端 + 本地双链路解析）
- 支持 Exa 联网搜索（后端自定义 URL / Key）
- 「思考与工具调用」折叠块展示联网与思考过程

## 后续可以继续加的东西

- 代码高亮
- IP 限流
- 模型过滤
- 自定义系统提示词
- 自定义域名
