# Google Health ChatGPT MCP

自托管、只读的 Google Health API v4 MCP 服务，可通过 OpenAI Responses API，或支持远程 MCP 的 ChatGPT 工作区读取并分析个人健康数据。

## 功能

- Google OAuth 2.0 一次授权，自动刷新 Google access token
- ChatGPT 到 MCP 使用 OAuth 2.1 Authorization Code + PKCE
- 支持 OAuth Protected Resource Metadata、Authorization Server Metadata 和动态客户端注册
- 为 ChatGPT 签发短期 access token 和可轮换 refresh token
- Streamable HTTP MCP 端点 `/mcp`
- 保留静态 `MCP_ACCESS_TOKEN`，供命令行管理、故障排查和回滚使用
- HTTP Basic 保护 Google OAuth 管理入口和 ChatGPT OAuth 授权确认
- 读取活动、睡眠、心率、HRV、血氧、每日呼吸率、睡眠温度变化、体重和运动记录
- 按日期范围读取单项数据、综合概览及两个周期对比
- Google refresh token 使用 AES-256-GCM 加密后存入 PostgreSQL
- Docker Compose 部署

## 两套 OAuth 的区别

本项目包含两套相互独立的 OAuth：

1. `ChatGPT → MCP`：本项目作为 OAuth 2.1 授权服务器，为 ChatGPT 签发 MCP access token 和 refresh token。
2. `MCP → Google Health`：本项目作为 Google OAuth 客户端，获取读取 Google Health 数据所需的令牌。

ChatGPT 不会获得 Google refresh token，Google Health 凭据只保存在本项目的 PostgreSQL 中。

## MCP 工具

- `get_profile`
- `list_devices`
- `query_health_data_type`
- `get_daily_rollup`
- `get_exercise_sessions`
- `get_health_overview`
- `compare_health_periods`

Google Health 不同账号、设备和地区可用的数据类型可能不同。原始协调查询使用 Google Health v4 data type slug，例如 `steps`、`sleep`、`exercise`、`heart-rate`、`daily-resting-heart-rate`、`daily-heart-rate-variability`、`daily-oxygen-saturation`、`daily-respiratory-rate`、`respiratory-rate-sleep-summary`、`daily-sleep-temperature-derivations`、`weight` 和 `core-body-temperature`。`total-calories` 等聚合类型通过 `get_daily_rollup` 查询。

## 快速开始

1. 在 Google Cloud 启用 Health API，创建 Web OAuth 客户端。

2. 将 Google 授权回调地址配置为：

```text
https://你的域名/oauth/google/callback
```

3. 复制并填写配置：

```bash
cp .env.example .env

openssl rand -base64 32  # TOKEN_ENCRYPTION_KEY
openssl rand -hex 32     # MCP_ACCESS_TOKEN
openssl rand -base64 24  # OAUTH_ADMIN_PASSWORD
```

请确保 `DATABASE_URL` 中的数据库密码与 `POSTGRES_PASSWORD` 一致。`OAUTH_ADMIN_PASSWORD` 同时用于 Google Health 管理授权和用户确认 ChatGPT 的 MCP OAuth 授权。

4. 启动数据库并应用最新表结构：

```bash
docker compose up -d postgres
docker compose run --rm app npm run db:init
```

5. 构建并启动应用：

```bash
docker compose up -d --build --force-recreate app
```

6. 浏览器访问以下地址，并输入 `OAUTH_ADMIN_USER` 和 `OAUTH_ADMIN_PASSWORD`，完成 Google Health 授权：

```text
https://你的域名/oauth/google/start
```

7. 检查服务：

```bash
curl https://你的域名/health
```

## 在 ChatGPT 中添加

MCP 地址：

```text
https://你的域名/mcp
```

认证方式选择 OAuth。ChatGPT 会依次执行：

1. 未携带令牌访问 `/mcp`，收到带 `resource_metadata` 的 `401`。
2. 获取 `/.well-known/oauth-protected-resource/mcp`。
3. 获取 `/.well-known/oauth-authorization-server/mcp`。
4. 调用 `/oauth/register` 动态注册公共 PKCE 客户端。
5. 打开 `/oauth/authorize`。浏览器会要求输入 `OAUTH_ADMIN_USER` 和 `OAUTH_ADMIN_PASSWORD`。
6. 使用 `/oauth/token` 换取 access token 和 refresh token。
7. 扫描 MCP 工具。

## OAuth 端点

```text
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-protected-resource/mcp
GET  /.well-known/oauth-authorization-server
GET  /.well-known/oauth-authorization-server/mcp
POST /oauth/register
GET  /oauth/authorize
POST /oauth/token
```

实现支持：

- Authorization Code
- PKCE S256
- Dynamic Client Registration
- Refresh Token
- Refresh Token Rotation
- Resource Indicator：`https://你的域名/mcp`
- Scope：`mcp:read`

## 静态 Token 测试

静态 `MCP_ACCESS_TOKEN` 仍可用于服务器端 curl 测试：

```bash
curl -X POST 'https://你的域名/mcp' \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data-raw '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"tools/list",
    "params":{}
  }'
```

## OpenAI Responses API 示例

```ts
const response = await client.responses.create({
  model: "gpt-5.4",
  input: "分析我最近28天的睡眠、运动和恢复趋势，并与此前28天比较。",
  tools: [{
    type: "mcp",
    server_label: "personal_health",
    server_url: "https://health.example.com/mcp",
    headers: {
      Authorization: `Bearer ${process.env.MCP_ACCESS_TOKEN}`
    },
    allowed_tools: ["get_health_overview", "compare_health_periods"],
    require_approval: "never"
  }]
});
```

## Nginx 反向代理要求

不能根据 OpenAI 的来源 IP、User-Agent、Referer 或空 Authorization 请求返回 444。首次 OAuth 探测访问 `/mcp` 时本来就没有 Bearer Token，必须转发给应用，让应用返回带 OAuth 元数据地址的 401。

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Mcp-Session-Id $http_mcp_session_id;
    proxy_set_header Last-Event-ID $http_last_event_id;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 3600s;
}

location ^~ /.well-known/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location ^~ /oauth/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

修改后检查：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

以下请求必须到达应用，不能返回 444：

```bash
curl -i https://你的域名/.well-known/oauth-protected-resource/mcp
curl -i https://你的域名/.well-known/oauth-authorization-server/mcp
curl -i -X POST https://你的域名/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"oauth-probe","version":"1.0"}}}'
```

最后一个请求在未携带令牌时应返回 `401`，且 `WWW-Authenticate` 中包含 `resource_metadata`。

## 升级已有部署

拉取代码后必须重新执行数据库初始化，脚本使用 `CREATE TABLE IF NOT EXISTS`，不会删除已有 Google OAuth 数据：

```bash
git pull
docker compose up -d postgres
docker compose run --rm app npm run db:init
docker compose up -d --build --force-recreate app
```

## 安全说明

本项目只开放读取工具。请仅通过 HTTPS 暴露服务，不要公开 `.env`、PostgreSQL 端口、MCP Token、Google 凭据或 OAuth 管理密码。OAuth authorization code 有效期为 5 分钟，access token 有效期为 1 小时，refresh token 有效期为 30 天并在每次使用时轮换。建议在反向代理层对 `/oauth/register`、`/oauth/authorize` 和 `/oauth/token` 加入合理速率限制，并对访问日志进行脱敏。

## 数据兼容性

Google Health API v4 的 reconcile 返回结构会随数据类型变化。服务会按照 interval、sample、daily、session 和 sleep 的时间字段，将日期范围下推到 Google API，并保留本地日期复核。若某种数据类型拒绝服务端过滤表达式，响应会标记 `serverFilterFallback: true` 并自动回退到本地筛选。睡眠按醒来日期归属，运动按开始日期归属，完全重复的睡眠阶段汇总会被清理并计入 `removedSleepStageDuplicates`。

综合概览和周期比较会对步数、心率、距离、活动区间分钟、活动消耗等高频数据使用每日汇总，避免长周期原始记录触发分页截断。每日汇总会自动按 Google API 的 14 天或 90 天范围上限分段。响应中的 `truncated` 表示达到 `maxPages` 后仍有数据未读取，应增大 `maxPages` 或缩小日期范围。

## License

MIT
