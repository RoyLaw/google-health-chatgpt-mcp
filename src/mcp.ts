import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { healthRequest } from './google.js';
import { audit } from './store.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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
    'query_health_data_source',
    '读取一个 Google Health v4 数据源。用于尚未封装的数据类型，只允许只读路径。dataSourceId 应来自 Google Health 文档或服务返回值。',
    {
      dataSourceId: z.string().min(1),
      startDate: date.optional(),
      endDate: date.optional(),
      pageSize: z.number().int().min(1).max(1000).default(100),
      pageToken: z.string().optional(),
    },
    async ({ dataSourceId, startDate, endDate, pageSize, pageToken }) => {
      await audit('mcp_query_data_source', { dataSourceId, startDate, endDate });
      return result(await healthRequest(`/v4/users/me/dataSources/${encodeURIComponent(dataSourceId)}/dataPoints`, {
        startDate,
        endDate,
        pageSize,
        pageToken,
      }));
    },
  );

  server.tool(
    'get_exercise_sessions',
    '读取运动训练记录',
    {
      beforeDate: date.optional(),
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
    '获取一段时间内的综合健康原始数据集合。调用方传入已确认的 Google Health 数据源 ID，服务并行读取并标记缺失数据。',
    {
      startDate: date,
      endDate: date,
      dataSources: z.object({
        steps: z.string().optional(),
        sleep: z.string().optional(),
        heartRate: z.string().optional(),
        hrv: z.string().optional(),
        spo2: z.string().optional(),
        respiratoryRate: z.string().optional(),
        skinTemperature: z.string().optional(),
        weight: z.string().optional(),
      }),
    },
    async ({ startDate, endDate, dataSources }) => {
      const entries = await Promise.all(Object.entries(dataSources).map(async ([name, id]) => [
        name,
        id ? await safe(name, () => healthRequest(`/v4/users/me/dataSources/${encodeURIComponent(id)}/dataPoints`, { startDate, endDate, pageSize: 1000 })) : { unavailable: true },
      ]));
      await audit('mcp_health_overview', { startDate, endDate, requested: Object.keys(dataSources) });
      return result({ period: { startDate, endDate }, data: Object.fromEntries(entries), generatedAt: new Date().toISOString() });
    },
  );

  server.tool(
    'compare_health_periods',
    '读取两个时间段的相同健康数据源，供 ChatGPT 比较趋势。服务返回两组原始数据和数据完整性信息。',
    {
      firstStartDate: date,
      firstEndDate: date,
      secondStartDate: date,
      secondEndDate: date,
      dataSourceIds: z.array(z.string().min(1)).min(1).max(10),
    },
    async (input) => {
      const readPeriod = async (startDate: string, endDate: string) => Object.fromEntries(
        await Promise.all(input.dataSourceIds.map(async (id) => [id, await safe(id, () => healthRequest(`/v4/users/me/dataSources/${encodeURIComponent(id)}/dataPoints`, { startDate, endDate, pageSize: 1000 }))])),
      );
      const [first, second] = await Promise.all([
        readPeriod(input.firstStartDate, input.firstEndDate),
        readPeriod(input.secondStartDate, input.secondEndDate),
      ]);
      await audit('mcp_compare_periods', input);
      return result({ firstPeriod: { startDate: input.firstStartDate, endDate: input.firstEndDate, data: first }, secondPeriod: { startDate: input.secondStartDate, endDate: input.secondEndDate, data: second } });
    },
  );

  return server;
}
