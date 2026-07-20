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
  if (token.accessToken && token.expiresAt && token.expiresAt.getTime() > Date.now() + 120_000) return token.accessToken;
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
  '/v4/users/me/devices',
  '/v4/users/me/dataTypes/',
  '/v4/users/me/exerciseSessions',
];

export async function healthRequest(path: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
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

export async function reconcileDataType(slug: string, pageSize = 1000): Promise<unknown> {
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error('Invalid Google Health data type slug');
  return healthRequest(`/v4/users/me/dataTypes/${slug}/dataPoints:reconcile`, { pageSize });
}
