import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { dailyRollUpDataType, healthRequest, reconcileDataType } from './google.js';
import { audit } from './store.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const slug = z.string().regex(/^[a-z0-9-]+$/i);
const defaultDataTypes = [
  'steps',
  'sleep',
  'exercise',
  'heart-rate',
  'daily-resting-heart-rate',
  'daily-heart-rate-variability',
  'daily-oxygen-saturation',
  'daily-respiratory-rate',
  'daily-sleep-temperature-derivations',
  'weight',
  'distance',
  'active-zone-minutes',
  'active-energy-burned',
];
const analysisRollupDataTypes = new Set([
  'steps',
  'heart-rate',
  'distance',
  'active-zone-minutes',
  'active-energy-burned',
  'sedentary-period',
  'total-calories',
  'activity-level',
]);

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

function ensureRange(startDate: string, endDate: string): void {
  if (startDate > endDate) throw new Error('startDate must not be later than endDate');
}

function queryForAnalysis(
  dataTypeSlug: string,
  startDate: string,
  endDate: string,
  pageSize: number,
  maxPages: number,
): Promise<unknown> {
  if (analysisRollupDataTypes.has(dataTypeSlug)) {
    return dailyRollUpDataType(dataTypeSlug, { startDate, endDate, pageSize, maxPages });
  }
  return reconcileDataType(dataTypeSlug, {
    startDate,
    endDate,
    pageSize,
    maxPages,
  });
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'personal-google-health', version: '0.3.0' });

  server.tool('get_profile', '读取 Google Health 个人资料', {}, async () => {
    await audit('mcp_get_profile', {});
    return result(await healthRequest('/v4/users/me/profile'));
  });

  server.tool('list_devices', '列出向 Google Health 提供数据的已配对设备', {}, async () => {
    await audit('mcp_list_devices', {});
    return result(await healthRequest('/v4/users/me/pairedDevices'));
  });

  server.tool(
    'query_health_data_type',
    '按日期范围读取一种 Google Health v4 原始协调数据。常见 slug 包括 steps、sleep、exercise、heart-rate、daily-resting-heart-rate、daily-heart-rate-variability、daily-oxygen-saturation、daily-respiratory-rate、daily-sleep-temperature-derivations、weight 和 core-body-temperature。总热量等只支持聚合的数据请使用 get_daily_rollup。',
    {
      slug,
      startDate: isoDate.optional(),
      endDate: isoDate.optional(),
      pageSize: z.number().int().min(1).max(10_000).default(10_000),
      maxPages: z.number().int().min(1).max(50).default(10),
    },
    async ({ slug: dataTypeSlug, startDate, endDate, pageSize, maxPages }) => {
      if (startDate && endDate) ensureRange(startDate, endDate);
      await audit('mcp_query_data_type', { dataTypeSlug, startDate, endDate, pageSize, maxPages });
      return result(await reconcileDataType(dataTypeSlug, {
        startDate,
        endDate,
        pageSize,
        maxPages,
      }));
    },
  );

  server.tool(
    'get_daily_rollup',
    '按自然日聚合 Google Health 数据，适合步数、心率、距离、总热量、活动区间分钟、活动消耗和久坐等高频指标。长时间范围会自动按 Google API 的 14 天或 90 天上限分段。',
    {
      slug,
      startDate: isoDate,
      endDate: isoDate,
      pageSize: z.number().int().min(1).max(10_000).default(10_000),
      maxPages: z.number().int().min(1).max(50).default(10),
    },
    async ({ slug: dataTypeSlug, startDate, endDate, pageSize, maxPages }) => {
      ensureRange(startDate, endDate);
      await audit('mcp_daily_rollup', { dataTypeSlug, startDate, endDate, pageSize, maxPages });
      return result(await dailyRollUpDataType(dataTypeSlug, {
        startDate,
        endDate,
        pageSize,
        maxPages,
      }));
    },
  );

  server.tool(
    'get_exercise_sessions',
    '读取指定日期范围内的运动训练记录。数据来自 Google Health exercise 数据类型。',
    {
      startDate: isoDate.optional(),
      endDate: isoDate.optional(),
      pageSize: z.number().int().min(1).max(25).default(25),
      maxPages: z.number().int().min(1).max(50).default(10),
    },
    async ({ startDate, endDate, pageSize, maxPages }) => {
      if (startDate && endDate) ensureRange(startDate, endDate);
      await audit('mcp_get_exercise_sessions', { startDate, endDate, pageSize, maxPages });
      return result(await reconcileDataType('exercise', {
        startDate,
        endDate,
        pageSize,
        maxPages,
      }));
    },
  );

  server.tool(
    'get_health_overview',
    '获取指定日期范围内的综合健康数据，适合分析运动、睡眠和恢复趋势。高频指标按日聚合，睡眠及每日恢复指标使用协调数据，每种类型独立返回错误和完整性信息。',
    {
      startDate: isoDate,
      endDate: isoDate,
      dataTypeSlugs: z.array(slug).min(1).max(20).default(defaultDataTypes),
      pageSize: z.number().int().min(1).max(10_000).default(10_000),
      maxPages: z.number().int().min(1).max(50).default(10),
    },
    async ({ startDate, endDate, dataTypeSlugs, pageSize, maxPages }) => {
      ensureRange(startDate, endDate);
      const entries = await Promise.all(dataTypeSlugs.map(async (dataTypeSlug) => [
        dataTypeSlug,
        await safe(dataTypeSlug, () => queryForAnalysis(
          dataTypeSlug,
          startDate,
          endDate,
          pageSize,
          maxPages,
        )),
      ]));
      await audit('mcp_health_overview', { startDate, endDate, dataTypeSlugs, pageSize, maxPages });
      return result({
        period: { startDate, endDate },
        data: Object.fromEntries(entries),
        generatedAt: new Date().toISOString(),
      });
    },
  );

  server.tool(
    'compare_health_periods',
    '读取两个日期范围内相同的健康指标，供 ChatGPT 比较活动量、睡眠、心率和恢复趋势。高频指标按日聚合，避免长周期原始数据被分页截断。',
    {
      firstStartDate: isoDate,
      firstEndDate: isoDate,
      secondStartDate: isoDate,
      secondEndDate: isoDate,
      dataTypeSlugs: z.array(slug).min(1).max(20).default(defaultDataTypes),
      pageSize: z.number().int().min(1).max(10_000).default(10_000),
      maxPages: z.number().int().min(1).max(50).default(10),
    },
    async (input) => {
      ensureRange(input.firstStartDate, input.firstEndDate);
      ensureRange(input.secondStartDate, input.secondEndDate);

      const readPeriod = async (startDate: string, endDate: string) => Object.fromEntries(
        await Promise.all(input.dataTypeSlugs.map(async (dataTypeSlug) => [
          dataTypeSlug,
          await safe(dataTypeSlug, () => queryForAnalysis(
            dataTypeSlug,
            startDate,
            endDate,
            input.pageSize,
            input.maxPages,
          )),
        ])),
      );

      const [firstData, secondData] = await Promise.all([
        readPeriod(input.firstStartDate, input.firstEndDate),
        readPeriod(input.secondStartDate, input.secondEndDate),
      ]);
      await audit('mcp_compare_health_periods', input);
      return result({
        firstPeriod: {
          startDate: input.firstStartDate,
          endDate: input.firstEndDate,
          data: firstData,
        },
        secondPeriod: {
          startDate: input.secondStartDate,
          endDate: input.secondEndDate,
          data: secondData,
        },
        generatedAt: new Date().toISOString(),
      });
    },
  );

  return server;
}
