# Google Health ChatGPT MCP

自托管、只读的 Google Health API v4 MCP 服务，可通过 OpenAI Responses API，或支持远程 MCP 的 ChatGPT 工作区读取并分析个人健康数据。

## 功能

- Google OAuth 2.0 一次授权，自动刷新 access token
- Streamable HTTP MCP 端点 `/mcp`
- Bearer Token 保护 MCP 入口
- HTTP Basic 保护 Google OAuth 管理入口
- 读取活动、睡眠、心率、HRV、血氧、呼吸率、皮温、体重和运动记录
- 按日期范围读取单项数据、综合概览及两个周期对比
- reconcile 接口自动分页，并标记截断状态
- Google refresh token 使用 AES-256-GCM 加密后存入 PostgreSQL
- Docker Compose 部署

## MCP 工具

- `get_profile`
- `list_devices`
- `query_health_data_type`
- `get_exercise_sessions`
- `get_health_overview`
- `compare_health_periods`

Google Health 不同账号、设备和地区可用的数据类型可能不同。通用工具使用 Google Health v4 data type slug，例如 `steps`、`sleep`、`heart-rate`、`heart-rate-variability`、`oxygen-saturation`、`respiratory-rate`、`skin-temperature`、`weight` 和 `exercise`。

## 快速开始

1. 在 Google Cloud 启用 Health API，创建 Web OAuth 客户端。
2. 将授权回调地址配置为：

```text
https://你的域名/oauth/google/callback
```

3. 复制并填写配置：

```bash
cp .env.example .env

# TOKEN_ENCRYPTION_KEY
openssl rand -base64 32

# MCP_ACCESS_TOKEN
openssl rand -hex 32

# OAUTH_ADMIN_PASSWORD
openssl rand -base64 24
```

请确保 `DATABASE_URL` 中的数据库密码与 `POSTGRES_PASSWORD` 一致。

4. 启动服务：

```bash
docker compose up -d --build
```

5. 浏览器访问以下地址，浏览器会要求输入 `OAUTH_ADMIN_USER` 和 `OAUTH_ADMIN_PASSWORD`：

```text
https://你的域名/oauth/google/start
```

6. 完成 Google 授权后检查服务：

```bash
curl https://你的域名/health
```

7. MCP 服务地址：

```text
https://你的域名/mcp
```

请求需要携带：

```http
Authorization: Bearer <MCP_ACCESS_TOKEN>
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
    allowed_tools: [
      "get_health_overview",
      "compare_health_periods"
    ],
    require_approval: "never"
  }]
});
```

模型调用 `get_health_overview` 时需要提供日期范围，例如：

```json
{
  "startDate": "2026-06-23",
  "endDate": "2026-07-20"
}
```

周期比较示例：

```json
{
  "firstStartDate": "2026-05-26",
  "firstEndDate": "2026-06-22",
  "secondStartDate": "2026-06-23",
  "secondEndDate": "2026-07-20"
}
```

## 反向代理要求

Nginx 或 Caddy 必须保留 `Authorization` 请求头，并关闭 MCP 路径的代理缓冲。Nginx 示例：

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

## 安全说明

本项目只开放读取工具。请仅通过 HTTPS 暴露服务，不要公开 `.env`、PostgreSQL 端口、MCP Token 或 OAuth 管理密码。OAuth 管理入口会覆盖当前保存的 Google 授权，因此必须保持管理员认证。建议同时在反向代理层加入速率限制和访问日志脱敏。

## 数据兼容性

Google Health API v4 的 reconcile 返回结构会随数据类型变化。服务保留原始 data point，并通过递归查找 civil date 实现日期范围筛选。无法识别 civil date 的记录在启用日期筛选时不会返回。响应中的 `truncated` 表示达到 `maxPages` 后仍有下一页，应增大 `maxPages` 或缩小日期范围。

## License

MIT
