import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { healthRequest, reconcileDataType } from './google.js';
import { audit } from './store.js';

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

async function safe(name: string, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), source: name };
  }
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'personal-google-health', version: '0.1.0' });

  server.tool('get_profile', '读取 Google Health 个人资料', {}, async () => {
    await audit('mcp_get_profile', {});
    return result(await healthRequest('/v4/users/me/profile'));
  });

  server.tool('list_devices', '列出向 Google Health 提供数据的设备', {}, async () => {
    await audit('mcp_list_devices', {});
    return result(await healthRequest('/v4/users/me/devices'));
  });

  server.tool(
    'query_health_data_type',
    '读取 Google Health v4 数据类型的最近数据点。slug 示例包括 steps、sleep、heart-rate、heart-rate-variability、oxygen-saturation、respiratory-rate、skin-temperature、weight。',
    {
      slug: z.string().regex(/^[a-z0-9-]+$/i),
      pageSize: z.number().int().min(1).max(1000).default(1000),
    },
    async ({ slug, pageSize }) => {
      await audit('mcp_query_data_type', { slug, pageSize });
      return result(await reconcileDataType(slug, pageSize));
    },
  );

  server.tool(
    'get_exercise_sessions',
    '读取运动训练记录',
    {
      beforeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      pageSize: z.number().int().min(1).max(100).default(30),
      pageToken: z.string().optional(),
    },
    async ({ beforeDate, pageSize, pageToken }) => {
      await audit('mcp_get_exercise_sessions', { beforeDate });
      return result(await healthRequest('/v4/users/me/exerciseSessions', { beforeDate, pageSize, pageToken }));
    },
  );

  server.tool(
    'get_health_overview',
    '并行读取多个 Google Health 数据类型，返回供 ChatGPT 分析的综合数据。默认覆盖活动、睡眠和恢复常用指标。',
    {
      dataTypeSlugs: z.array(z.string().regex(/^[a-z0-9-]+$/i)).min(1).max(16).default([
        'steps',
        'sleep',
        'heart-rate',
        'heart-rate-variability',
        'oxygen-saturation',
        'respiratory-rate',
        'skin-temperature',
        'weight',
      ]),
      pageSize: z.number().int().min(1).max(1000).default(1000),
    },
    async ({ dataTypeSlugs, pageSize }) => {
      const entries = await Promise.all(dataTypeSlugs.map(async (slug) => [
        slug,
        await safe(slug, () => reconcileDataType(slug, pageSize)),
      ]));
      await audit('mcp_health_overview', { dataTypeSlugs, pageSize });
      return result({ data: Object.fromEntries(entries), generatedAt: new Date().toISOString() });
    },
  );

  server.tool(
    'compare_health_snapshots',
    '获取同一组数据类型的当前快照。ChatGPT 可将结果与会话中先前保存的快照比较。Google Health reconcile 接口提供最近数据点，日期范围需根据返回记录中的 civil date 由模型筛选。',
    {
      dataTypeSlugs: z.array(z.string().regex(/^[a-z0-9-]+$/i)).min(1).max(16),
      pageSize: z.number().int().min(1).max(1000).default(1000),
    },
    async ({ dataTypeSlugs, pageSize }) => {
      const data = Object.fromEntries(await Promise.all(dataTypeSlugs.map(async (slug) => [
        slug,
        await safe(slug, () => reconcileDataType(slug, pageSize)),
      ])));
      await audit('mcp_compare_health_snapshots', { dataTypeSlugs, pageSize });
      return result({ data, generatedAt: new Date().toISOString() });
    },
  );

  return server;
}
