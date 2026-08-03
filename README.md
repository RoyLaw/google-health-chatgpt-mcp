# 🩺 GPT Health MCP

> 一个自托管、只读的 Google Health MCP 服务，为 GPT 系列 AI 助手提供个人健康数据访问与分析能力。

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![Docker](https://img.shields.io/badge/Docker-ready-blue)
![MCP](https://img.shields.io/badge/MCP-Compatible-green)

## ✨ 项目简介

GPT Health MCP 是一个个人健康数据智能网关，通过 Google Health API 获取授权后的健康数据，并通过 Model Context Protocol（MCP）安全提供给 ChatGPT 或其他 AI 助手进行分析。

项目采用只读设计，AI 助手不会直接获得 Google Health OAuth 凭据。

## 🏗 架构

```text
Google Health
      │
      ▼
Google OAuth
      │
      ▼
GPT Health MCP
      │
   MCP Protocol
      │
      ▼
GPT / ChatGPT
```

## 🧰 MCP 工具

- `get_profile`
- `list_devices`
- `query_health_data_type`
- `get_daily_rollup`
- `get_exercise_sessions`
- `get_health_overview`
- `compare_health_periods`

支持分析：

- 睡眠和睡眠阶段
- 步数、运动量和训练趋势
- 心率、静息心率、HRV
- 血氧和呼吸率
- 体重等身体指标

## 🚀 部署

项目支持 Docker Compose 自托管部署。

```bash
cp .env.example .env
docker compose up -d --build
```

完成 Google OAuth 授权后，即可通过 MCP 地址提供健康数据。

```text
https://你的域名/mcp
```

## 🔒 安全设计

- 仅提供只读健康数据访问
- Google refresh token 加密保存
- MCP 独立认证
- HTTPS 部署
- 不向 AI 暴露 Google OAuth 凭据

## 📦 技术栈

- TypeScript
- Hono
- Model Context Protocol SDK
- Google Health API v4
- PostgreSQL
- Docker Compose

## 📄 License

MIT
