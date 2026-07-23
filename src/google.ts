import crypto from 'node:crypto';
import { config, googleScopes } from './config.js';
import {
  buildReconcileFilter,
  civilDateTime,
  dailyRollupDataTypes,
  isRecord,
  maxDailyRollupRangeDays,
  maxReconcilePageSize,
  normalizeReconciledPoint,
  observationDate,
  sortDailyRollupDataPoints,
  splitDailyRollupRange,
} from './health-data.js';
import { audit, loadGoogleToken, saveGoogleToken, updateAccessToken } from './store.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const HEALTH_BASE = 'https://health.googleapis.com';
const pendingStates = new Map<string, number>();
const DAILY_ROLLUP_DATA_TYPES = new Set(dailyRollupDataTypes);

export function createAuthorizationUrl(): string {
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, Date.now() + 10 * 60_000);
  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set('client_id', config.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${config.PUBLIC_BASE_URL}/oauth/google/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', googleScopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeAuthorizationCode(code: string, state: string): Promise<void> {
  const expiry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!expiry || expiry < Date.now()) throw new Error('OAuth state is invalid or expired');

  const response = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${config.PUBLIC_BASE_URL}/oauth/google/callback`,
    }),
  });
  const json = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof json.refresh_token !== 'string') {
    throw new Error(`Google token exchange failed: ${JSON.stringify(json)}`);
  }
  await saveGoogleToken({
    refreshToken: json.refresh_token,
    accessToken: typeof json.access_token === 'string' ? json.access_token : undefined,
    expiresAt: new Date(Date.now() + Number(json.expires_in ?? 3600) * 1000),
    scopes: typeof json.scope === 'string' ? json.scope : googleScopes.join(' '),
  });
  await audit('google_oauth_authorized', { scopes: json.scope });
}

async function accessToken(): Promise<string> {
  const token = await loadGoogleToken();
  if (!token) throw new Error('Google Health is not authorized. Visit /oauth/google/start first.');
  if (token.accessToken && token.expiresAt && token.expiresAt.getTime() > Date.now() + 120_000) {
    return token.accessToken;
  }

  const response = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      refresh_token: token.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const json = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof json.access_token !== 'string') {
    throw new Error(`Google token refresh failed: ${JSON.stringify(json)}`);
  }
  const expiresAt = new Date(Date.now() + Number(json.expires_in ?? 3600) * 1000);
  await updateAccessToken(json.access_token, expiresAt);
  return json.access_token;
}

const ALLOWED_PREFIXES = [
  '/v4/users/me/profile',
  '/v4/users/me/pairedDevices',
  '/v4/users/me/dataTypes/',
];

type QueryValue = string | number | undefined;
type HealthRequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
};

export async function healthRequest(
  path: string,
  query: Record<string, QueryValue> = {},
  options: HealthRequestOptions = {},
): Promise<unknown> {
  if (!ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new Error('Requested Google Health path is not in the read-only allowlist');
  }
  const url = new URL(path, HEALTH_BASE);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }
  const method = options.method ?? 'GET';
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      Accept: 'application/json',
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Health ${response.status}: ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : null;
}

export type ReconcileOptions = {
  pageSize?: number;
  maxPages?: number;
  startDate?: string;
  endDate?: string;
};

export type ReconcileResult = {
  mode: 'reconcile';
  slug: string;
  dataPoints: Array<Record<string, unknown>>;
  fetchedPages: number;
  truncated: boolean;
  dateFilterApplied: boolean;
  serverFilterApplied: boolean;
  serverFilterFallback: boolean;
  removedSleepStageDuplicates: number;
};

export async function reconcileDataType(
  slug: string,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error('Invalid Google Health data type slug');
  const maximumPageSize = maxReconcilePageSize(slug);
  const pageSize = Math.min(Math.max(options.pageSize ?? maximumPageSize, 1), maximumPageSize);
  const maxPages = Math.min(Math.max(options.maxPages ?? 10, 1), 50);
  const dataPoints: Array<Record<string, unknown>> = [];
  let pageToken: string | undefined;
  let fetchedPages = 0;
  let truncated = false;
  let serverFilter = buildReconcileFilter(slug, options.startDate, options.endDate);
  let serverFilterFallback = false;
  let removedSleepStageDuplicates = 0;

  do {
    let response: unknown;
    try {
      response = await healthRequest(
        `/v4/users/me/dataTypes/${slug}/dataPoints:reconcile`,
        { pageSize, pageToken, filter: serverFilter },
      );
    } catch (error) {
      if (serverFilter && fetchedPages === 0) {
        serverFilter = undefined;
        serverFilterFallback = true;
        response = await healthRequest(
          `/v4/users/me/dataTypes/${slug}/dataPoints:reconcile`,
          { pageSize, pageToken },
        );
      } else {
        throw error;
      }
    }
    if (!isRecord(response)) throw new Error(`Unexpected reconcile response for ${slug}`);
    const points = Array.isArray(response.dataPoints)
      ? response.dataPoints.filter(isRecord)
      : [];
    for (const point of points) {
      const normalized = normalizeReconciledPoint(point, slug);
      dataPoints.push(normalized.point);
      removedSleepStageDuplicates += normalized.removedSleepStageDuplicates;
    }
    pageToken = typeof response.nextPageToken === 'string' && response.nextPageToken
      ? response.nextPageToken
      : undefined;
    fetchedPages += 1;
    if (pageToken && fetchedPages >= maxPages) {
      truncated = true;
      break;
    }
  } while (pageToken);

  const hasDateRange = Boolean(options.startDate || options.endDate);
  const filtered = hasDateRange
    ? dataPoints.filter((point) => {
        const date = observationDate(point, slug);
        if (!date) return false;
        if (options.startDate && date < options.startDate) return false;
        if (options.endDate && date > options.endDate) return false;
        return true;
      })
    : dataPoints;

  return {
    mode: 'reconcile',
    slug,
    dataPoints: filtered,
    fetchedPages,
    truncated,
    dateFilterApplied: hasDateRange,
    serverFilterApplied: Boolean(serverFilter),
    serverFilterFallback,
    removedSleepStageDuplicates,
  };
}

export type DailyRollupOptions = {
  startDate: string;
  endDate: string;
  pageSize?: number;
  maxPages?: number;
};

export type DailyRollupResult = {
  mode: 'daily-rollup';
  slug: string;
  period: { startDate: string; endDate: string };
  rollupDataPoints: Array<Record<string, unknown>>;
  fetchedPages: number;
  requestedChunks: number;
  completedChunks: number;
  truncated: boolean;
};

export async function dailyRollUpDataType(
  slug: string,
  options: DailyRollupOptions,
): Promise<DailyRollupResult> {
  if (!DAILY_ROLLUP_DATA_TYPES.has(slug)) {
    throw new Error(`Google Health daily rollup is not supported for data type: ${slug}`);
  }
  const maximumRangeDays = maxDailyRollupRangeDays(slug);
  const pageSize = Math.min(Math.max(options.pageSize ?? maximumRangeDays, 1), maximumRangeDays);
  const maxPages = Math.min(Math.max(options.maxPages ?? 10, 1), 50);
  const chunks = splitDailyRollupRange(slug, options.startDate, options.endDate);
  const rollupDataPoints: Array<Record<string, unknown>> = [];
  let fetchedPages = 0;
  let completedChunks = 0;
  let truncated = false;

  for (const chunk of chunks) {
    if (fetchedPages >= maxPages) {
      truncated = true;
      break;
    }
    let pageToken: string | undefined;
    do {
      const response = await healthRequest(
        `/v4/users/me/dataTypes/${slug}/dataPoints:dailyRollUp`,
        {},
        {
          method: 'POST',
          body: {
            range: {
              start: civilDateTime(chunk.startDate),
              end: civilDateTime(chunk.exclusiveEndDate),
            },
            windowSizeDays: 1,
            pageSize,
            pageToken,
          },
        },
      );
      if (!isRecord(response)) throw new Error(`Unexpected daily rollup response for ${slug}`);
      const points = Array.isArray(response.rollupDataPoints)
        ? response.rollupDataPoints.filter(isRecord)
        : [];
      rollupDataPoints.push(...points);
      pageToken = typeof response.nextPageToken === 'string' && response.nextPageToken
        ? response.nextPageToken
        : undefined;
      fetchedPages += 1;
      if (pageToken && fetchedPages >= maxPages) {
        truncated = true;
        break;
      }
    } while (pageToken);
    if (truncated) break;
    completedChunks += 1;
  }

  return {
    mode: 'daily-rollup',
    slug,
    period: { startDate: options.startDate, endDate: options.endDate },
    rollupDataPoints: sortDailyRollupDataPoints(rollupDataPoints),
    fetchedPages,
    requestedChunks: chunks.length,
    completedChunks,
    truncated,
  };
}
