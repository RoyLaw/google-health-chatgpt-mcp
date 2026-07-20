# Google Health ChatGPT MCP

自托管、只读的 Google Health API v4 MCP 服务，可通过 OpenAI Responses API 或支持远程 MCP 的 ChatGPT 工作区分析个人健康数据。

## 功能

- Google OAuth 2.0 一次授权，自动刷新 access token
- Streamable HTTP MCP 端点 `/mcp`
- Bearer Token 保护 MCP 入口
- 活动、睡眠、心率、HRV、血氧、呼吸率、皮温、体重等读取接口
- 综合健康概览和两个周期对比工具
- Docker Compose 部署

## 快速开始

1. 在 Google Cloud 启用 Health API，创建 Web OAuth 客户端。
2. 将回调地址配置为 `https://你的域名/oauth/google/callback`。
3. 复制配置：

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -base64 32
```

4. 填写 `.env`，启动服务：

```bash
docker compose up -d --build
```

5. 浏览器访问 `https://你的域名/oauth/google/start` 完成一次授权。
6. 健康检查：`GET /health`。
7. MCP 地址：`https://你的域名/mcp`，请求头：`Authorization: Bearer <MCP_ACCESS_TOKEN>`。

## OpenAI Responses API 示例

```ts
const response = await client.responses.create({
  model: "gpt-5.4",
  input: "分析我最近28天的睡眠、运动和恢复趋势，并与此前28天比较。",
  tools: [{
    type: "mcp",
    server_label: "personal_health",
    server_url: "https://health.example.com/mcp",
    headers: { Authorization: `Bearer ${process.env.MCP_ACCESS_TOKEN}` },
    allowed_tools: ["get_health_overview", "compare_health_periods"],
    require_approval: "never"
  }]
});
```

## 安全说明

本项目只实现读取能力。Google refresh token 使用 AES-256-GCM 加密后保存在 PostgreSQL。请仅通过 HTTPS 暴露服务，不要将 `.env`、数据库端口或 MCP Token 暴露到公网。

## 数据接口兼容性

Google Health API v4 的数据类型可能因账号、设备和地区而异。底层工具返回 API 原始 JSON，同时综合工具附带数据完整性和错误信息，便于定位尚未开放或无数据的数据类型。

## License

MIT
