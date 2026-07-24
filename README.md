# 🩺 Google Health ChatGPT MCP

> 一个自托管、只读的 Google Health MCP 服务，让 ChatGPT 能够安全读取并分析个人健康数据。

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![Docker](https://img.shields.io/badge/Docker-ready-blue)
![MCP](https://img.shields.io/badge/MCP-Compatible-green)
![OAuth](https://img.shields.io/badge/OAuth-2.1-orange)
![License](https://img.shields.io/github/license/RoyLaw/google-health-chatgpt-mcp)

## ✨ 功能

- 💤 睡眠与睡眠阶段分析
- 🚶 步数、距离和活动量统计
- ❤️ 心率与静息心率
- 🩸 血氧、呼吸率和 HRV
- 🏃 运动记录与训练趋势
- ⚖️ 体重等健康数据查询
- 📊 综合概览与周期对比
- 🔐 ChatGPT OAuth 2.1 + PKCE
- 🐳 Docker Compose 自托管部署

## 🏗 工作方式

```text
Google Health
      │
      ▼
Google OAuth
      │
      ▼
Google Health MCP
      │
   OAuth 2.1
      │
      ▼
   ChatGPT
```

项目包含两套相互独立的 OAuth：

1. `ChatGPT → MCP`：本项目作为 OAuth 2.1 授权服务器，为 ChatGPT 签发访问令牌。
2. `MCP → Google Health`：本项目作为 Google OAuth 客户端，读取个人健康数据。

ChatGPT 不会获得 Google refresh token，相关凭据仅保存在自建 PostgreSQL 中。

## 🧰 MCP 工具

- `get_profile`
- `list_devices`
- `query_health_data_type`
- `get_daily_rollup`
- `get_exercise_sessions`
- `get_health_overview`
- `compare_health_periods`

可查询的数据包括步数、睡眠、运动、心率、静息心率、HRV、血氧、呼吸率、睡眠温度变化、体重等。实际可用范围取决于账号、设备及 Google Health 中已有的数据。

## 🚀 快速部署

### 1. 准备 Google OAuth

在 Google Cloud 中启用 Health API，创建 Web OAuth 客户端，并配置回调地址：

```text
https://你的域名/oauth/google/callback
```

### 2. 配置环境变量

```bash
cp .env.example .env

openssl rand -base64 32  # TOKEN_ENCRYPTION_KEY
openssl rand -hex 32     # MCP_ACCESS_TOKEN
openssl rand -base64 24  # OAUTH_ADMIN_PASSWORD
```

请确保 `DATABASE_URL` 中的数据库密码与 `POSTGRES_PASSWORD` 一致。

### 3. 初始化并启动

```bash
docker compose up -d postgres
docker compose build app
docker compose run --rm app npm run db:init
docker compose up -d --build --force-recreate app
```

### 4. 完成 Google 授权

浏览器访问：

```text
https://你的域名/oauth/google/start
```

输入 `OAUTH_ADMIN_USER` 和 `OAUTH_ADMIN_PASSWORD`，完成 Google Health 授权。

### 5. 检查服务

```bash
curl https://你的域名/health
```

## 🤖 添加到 ChatGPT

MCP 地址：

```text
https://你的域名/mcp
```

认证方式选择 OAuth。ChatGPT 将自动完成 OAuth 元数据发现、动态客户端注册、PKCE 授权及 MCP 工具扫描。

可直接提问：

- 昨晚睡眠情况如何？
- 最近是否出现血氧异常？
- 本周运动量与上周相比怎样？
- 分析最近 28 天的睡眠、运动和恢复趋势。

## 🌐 Nginx 反向代理

以下路径必须正常转发到应用，不能根据来源 IP、User-Agent、Referer 或空 Authorization 请求返回 `444`：

```text
/mcp
/.well-known/
/oauth/
```

示例配置：

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

未携带令牌访问 `/mcp` 时，应返回 `401`，并在 `WWW-Authenticate` 中包含 `resource_metadata`。

## 🔄 更新部署

```bash
git pull
docker compose up -d postgres
docker compose build app
docker compose run --rm app npm run db:init
docker compose up -d --force-recreate app
```

数据库初始化使用 `CREATE TABLE IF NOT EXISTS`，不会删除已有授权数据。

## 🔒 安全说明

- 服务仅提供只读工具。
- 仅通过 HTTPS 对外提供服务。
- 不要公开 `.env`、数据库端口、Google 凭据、MCP Token 或管理密码。
- Google refresh token 使用 AES-256-GCM 加密后存入 PostgreSQL。
- 建议对 OAuth 接口设置合理的访问频率限制，并对日志进行脱敏。

## 📦 技术栈

- TypeScript
- Hono
- Model Context Protocol SDK
- PostgreSQL
- Docker Compose
- Google Health API v4

## 📄 License

MIT
