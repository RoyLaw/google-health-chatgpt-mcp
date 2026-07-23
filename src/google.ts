import crypto from 'node:crypto';
import { config, googleScopes } from './config.js';
import { audit, loadGoogleToken, saveGoogleToken, updateAccessToken } from './store.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const HEALTH_BASE = 'https://health.googleapis.com';
const pendingStates = new Map<string, number>();

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

export async function healthRequest(
  path: string,
  query: Record<string, QueryValue> = {},
): Promise<unknown> {
  if (!ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new Error('Requested Google Health path is not in the read-only allowlist');
  }
  const url = new URL(path, HEALTH_BASE);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Health ${response.status}: ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function civilDate(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const year = value.year;
  const month = value.month;
  const day = value.day;
  if (typeof year === 'number' && typeof month === 'number' && typeof day === 'number') {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  for (const child of Object.values(value)) {
    const found = civilDate(child);
    if (found) return found;
  }
  return undefined;
}

function timestampDate(timestamp: unknown, utcOffset: unknown): string | undefined {
  if (typeof timestamp !== 'string' || typeof utcOffset !== 'string') return undefined;
  const offsetMatch = /^([+-]?\d+(?:\.\d+)?)s$/.exec(utcOffset);
  if (!offsetMatch) return undefined;
  const instant = Date.parse(timestamp);
  const offsetSeconds = Number(offsetMatch[1]);
  if (!Number.isFinite(instant) || !Number.isFinite(offsetSeconds)) return undefined;
  return new Date(instant + offsetSeconds * 1000).toISOString().slice(0, 10);
}

function timestampBasedDate(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;

  // Session records such as sleep and exercise are assigned to their local end
  // date, so an overnight session belongs to the day on which the user wakes.
  const direct = timestampDate(value.endTime, value.endUtcOffset)
    ?? timestampDate(value.startTime, value.startUtcOffset)
    ?? timestampDate(value.physicalTime, value.utcOffset);
  if (direct) return direct;

  for (const child of Object.values(value)) {
    const found = timestampBasedDate(child);
    if (found) return found;
  }
  return undefined;
}

function observationDate(value: unknown): string | undefined {
  return civilDate(value) ?? timestampBasedDate(value);
}

export type ReconcileOptions = {
  pageSize?: number;
  maxPages?: number;
  startDate?: string;
  endDate?: string;
};

export type ReconcileResult = {
  slug: string;
  dataPoints: Array<Record<string, unknown>>;
  fetchedPages: number;
  truncated: boolean;
  dateFilterApplied: boolean;
};

export async function reconcileDataType(
  slug: string,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error('Invalid Google Health data type slug');
  const pageSize = Math.min(Math.max(options.pageSize ?? 1000, 1), 1000);
  const maxPages = Math.min(Math.max(options.maxPages ?? 10, 1), 50);
  const dataPoints: Array<Record<string, unknown>> = [];
  let pageToken: string | undefined;
  let fetchedPages = 0;
  let truncated = false;

  do {
    const response = await healthRequest(
      `/v4/users/me/dataTypes/${slug}/dataPoints:reconcile`,
      { pageSize, pageToken },
    );
    if (!isRecord(response)) throw new Error(`Unexpected reconcile response for ${slug}`);
    const points = Array.isArray(response.dataPoints)
      ? response.dataPoints.filter(isRecord)
      : [];
    dataPoints.push(...points);
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
        const date = observationDate(point);
        if (!date) return false;
        if (options.startDate && date < options.startDate) return false;
        if (options.endDate && date > options.endDate) return false;
        return true;
      })
    : dataPoints;

  return {
    slug,
    dataPoints: filtered,
    fetchedPages,
    truncated,
    dateFilterApplied: hasDateRange,
  };
}
