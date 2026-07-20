import crypto from 'node:crypto';
import type { Hono } from 'hono';
import { config } from './config.js';
import { pool } from './store.js';

const MCP_RESOURCE = `${config.PUBLIC_BASE_URL}/mcp`;
const MCP_SCOPE = 'mcp:read';
const ACCESS_TOKEN_TTL = 3600;
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;
const CODE_TTL = 300;

const noStoreHeaders = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(value: string, expected: string): boolean {
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function adminAuthorized(header: string | undefined): boolean {
  if (!header?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator >= 0
      && safeEqual(decoded.slice(0, separator), config.OAUTH_ADMIN_USER)
      && safeEqual(decoded.slice(separator + 1), config.OAUTH_ADMIN_PASSWORD);
  } catch {
    return false;
  }
}

function errorResponse(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: noStoreHeaders },
  );
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname));
  } catch {
    return false;
  }
}

function redirectError(redirectUri: string, state: string | undefined, error: string, description: string): string {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state);
  return target.toString();
}

async function issueTokens(clientId: string, scope: string, resource: string, familyId = crypto.randomUUID()) {
  const accessToken = randomToken();
  const refreshToken = randomToken();

  await pool.query(
    `INSERT INTO mcp_oauth_tokens
      (token_hash, token_type, client_id, scope, resource, family_id, expires_at)
     VALUES
      ($1, 'access', $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 second')),
      ($7, 'refresh', $2, $3, $4, $5, NOW() + ($8 * INTERVAL '1 second'))`,
    [
      sha256(accessToken), clientId, scope, resource, familyId, ACCESS_TOKEN_TTL,
      sha256(refreshToken), REFRESH_TOKEN_TTL,
    ],
  );

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope,
  };
}

export async function verifyMcpAccessToken(token: string): Promise<boolean> {
  // Keep the original static token for command-line administration and rollback.
  if (config.MCP_ACCESS_TOKEN && safeEqual(token, config.MCP_ACCESS_TOKEN)) return true;

  const result = await pool.query(
    `SELECT 1 FROM mcp_oauth_tokens
      WHERE token_hash = $1
        AND token_type = 'access'
        AND resource = $2
        AND revoked_at IS NULL
        AND expires_at > NOW()`,
    [sha256(token), MCP_RESOURCE],
  );
  return result.rowCount === 1;
}

export function mcpResourceMetadataUrl(): string {
  return `${config.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp`;
}

export function registerOAuthRoutes(app: Hono): void {
  const resourceMetadata = {
    resource: MCP_RESOURCE,
    authorization_servers: [config.PUBLIC_BASE_URL],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
  };

  const serverMetadata = {
    issuer: config.PUBLIC_BASE_URL,
    authorization_endpoint: `${config.PUBLIC_BASE_URL}/oauth/authorize`,
    token_endpoint: `${config.PUBLIC_BASE_URL}/oauth/token`,
    registration_endpoint: `${config.PUBLIC_BASE_URL}/oauth/register`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };

  app.get('/.well-known/oauth-protected-resource', (c) => c.json(resourceMetadata));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(resourceMetadata));
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(serverMetadata));
  app.get('/.well-known/oauth-authorization-server/mcp', (c) => c.json(serverMetadata));

  app.post('/oauth/register', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return errorResponse('invalid_client_metadata', 'Request body must be valid JSON');
    }

    const redirectUris = stringArray(body.redirect_uris);
    if (!redirectUris || !redirectUris.every(validRedirectUri)) {
      return errorResponse('invalid_redirect_uri', 'Valid HTTPS or loopback redirect_uris are required');
    }

    const grantTypes = stringArray(body.grant_types) ?? ['authorization_code', 'refresh_token'];
    const responseTypes = stringArray(body.response_types) ?? ['code'];
    if (!grantTypes.includes('authorization_code') || !responseTypes.includes('code')) {
      return errorResponse('invalid_client_metadata', 'authorization_code and code are required');
    }
    if ((body.token_endpoint_auth_method ?? 'none') !== 'none') {
      return errorResponse('invalid_client_metadata', 'Only public PKCE clients are supported');
    }

    const clientId = randomToken(24);
    const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : 'ChatGPT MCP client';
    await pool.query(
      `INSERT INTO mcp_oauth_clients
       (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, 'none')`,
      [clientId, clientName, JSON.stringify(redirectUris), JSON.stringify(grantTypes), JSON.stringify(responseTypes)],
    );

    return c.json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: 'none',
    }, 201, noStoreHeaders);
  });

  app.get('/oauth/authorize', async (c) => {
    const clientId = c.req.query('client_id');
    const redirectUri = c.req.query('redirect_uri');
    const state = c.req.query('state');
    const responseType = c.req.query('response_type');
    const challenge = c.req.query('code_challenge');
    const challengeMethod = c.req.query('code_challenge_method');
    const resource = c.req.query('resource') || MCP_RESOURCE;
    const scope = c.req.query('scope') || MCP_SCOPE;

    if (!clientId || !redirectUri) return errorResponse('invalid_request', 'client_id and redirect_uri are required');

    const client = await pool.query('SELECT redirect_uris FROM mcp_oauth_clients WHERE client_id = $1', [clientId]);
    if (client.rowCount !== 1) return errorResponse('unauthorized_client', 'Unknown OAuth client', 401);

    const allowedRedirectUris = client.rows[0].redirect_uris as string[];
    if (!allowedRedirectUris.includes(redirectUri)) {
      return errorResponse('invalid_request', 'redirect_uri does not match the registered client');
    }
    if (responseType !== 'code') {
      return c.redirect(redirectError(redirectUri, state, 'unsupported_response_type', 'Only code is supported'));
    }
    if (!challenge || challengeMethod !== 'S256') {
      return c.redirect(redirectError(redirectUri, state, 'invalid_request', 'PKCE S256 is required'));
    }
    if (resource !== MCP_RESOURCE) {
      return c.redirect(redirectError(redirectUri, state, 'invalid_target', 'Unsupported resource'));
    }
    const scopes = scope.split(/\s+/).filter(Boolean);
    if (scopes.length === 0 || scopes.some((item) => item !== MCP_SCOPE)) {
      return c.redirect(redirectError(redirectUri, state, 'invalid_scope', 'Unsupported scope'));
    }

    if (!adminAuthorized(c.req.header('Authorization'))) {
      c.header('WWW-Authenticate', 'Basic realm="Authorize ChatGPT for Google Health MCP", charset="UTF-8"');
      return c.text('Enter the MCP administrator credentials to authorize this ChatGPT connection.', 401);
    }

    const code = randomToken();
    await pool.query(
      `INSERT INTO mcp_oauth_codes
       (code_hash, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 * INTERVAL '1 second'))`,
      [sha256(code), clientId, redirectUri, challenge, scopes.join(' '), resource, CODE_TTL],
    );

    const callback = new URL(redirectUri);
    callback.searchParams.set('code', code);
    if (state) callback.searchParams.set('state', state);
    return c.redirect(callback.toString());
  });

  app.post('/oauth/token', async (c) => {
    const body = await c.req.parseBody();
    const grantType = typeof body.grant_type === 'string' ? body.grant_type : '';
    const clientId = typeof body.client_id === 'string' ? body.client_id : '';
    if (!clientId) return errorResponse('invalid_client', 'client_id is required', 401);

    const registered = await pool.query('SELECT 1 FROM mcp_oauth_clients WHERE client_id = $1', [clientId]);
    if (registered.rowCount !== 1) return errorResponse('invalid_client', 'Unknown OAuth client', 401);

    if (grantType === 'authorization_code') {
      const code = typeof body.code === 'string' ? body.code : '';
      const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
      const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
      if (!code || !redirectUri || !verifier) {
        return errorResponse('invalid_request', 'code, redirect_uri, and code_verifier are required');
      }

      const expectedChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const exchanged = await pool.query(
        `UPDATE mcp_oauth_codes
            SET used_at = NOW()
          WHERE code_hash = $1
            AND client_id = $2
            AND redirect_uri = $3
            AND code_challenge = $4
            AND used_at IS NULL
            AND expires_at > NOW()
        RETURNING scope, resource`,
        [sha256(code), clientId, redirectUri, expectedChallenge],
      );
      if (exchanged.rowCount !== 1) return errorResponse('invalid_grant', 'Authorization code is invalid or expired');

      const tokens = await issueTokens(clientId, exchanged.rows[0].scope, exchanged.rows[0].resource);
      return c.json(tokens, 200, noStoreHeaders);
    }

    if (grantType === 'refresh_token') {
      const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
      if (!refreshToken) return errorResponse('invalid_request', 'refresh_token is required');

      const rotated = await pool.query(
        `UPDATE mcp_oauth_tokens
            SET revoked_at = NOW()
          WHERE token_hash = $1
            AND token_type = 'refresh'
            AND client_id = $2
            AND revoked_at IS NULL
            AND expires_at > NOW()
        RETURNING scope, resource, family_id`,
        [sha256(refreshToken), clientId],
      );
      if (rotated.rowCount !== 1) return errorResponse('invalid_grant', 'Refresh token is invalid or expired');

      const tokens = await issueTokens(clientId, rotated.rows[0].scope, rotated.rows[0].resource, rotated.rows[0].family_id);
      return c.json(tokens, 200, noStoreHeaders);
    }

    return errorResponse('unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
  });
}
