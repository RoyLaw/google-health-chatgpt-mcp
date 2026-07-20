import crypto from 'node:crypto';
import type { Hono } from 'hono';
import { config } from './config.js';
import { pool } from './store.js';

const MCP_RESOURCE = `${config.PUBLIC_BASE_URL}/mcp`;
const DEFAULT_SCOPE = 'mcp:read';
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function tokenHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function timingSafeTextEqual(value: string, expected: string): boolean {
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function oauthAdminAuthorized(header: string | undefined): boolean {
  if (!header?.startsWith('Basic ')) return false;

  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;

    return timingSafeTextEqual(decoded.slice(0, separator), config.OAUTH_ADMIN_USER)
      && timingSafeTextEqual(decoded.slice(separator + 1), config.OAUTH_ADMIN_PASSWORD);
  } catch {
    return false;
  }
}

function oauthError(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    },
  );
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((item) => typeof item === 'string')) return null;
  return value;
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function appendOAuthError(redirectUri: string, state: string | undefined, error: string, description: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

async function issueTokenPair(clientId: string, scope: string, resource: string, familyId?: string) {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const tokenFamilyId = familyId ?? crypto.randomUUID();

  await pool.query('BEGIN');
  try {
    await pool.query(
      `INSERT INTO mcp_oauth_tokens
        (token_hash, token_type, client_id, scope, resource, family_id, expires_at)
       VALUES
        ($1, 'access', $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 second')),
        ($7, 'refresh', $2, $3, $4, $5, NOW() + ($8 * INTERVAL '1 second'))`,
      [
        tokenHash(accessToken),
        clientId,
        scope,
        resource,
        tokenFamilyId,
        ACCESS_TOKEN_TTL_SECONDS,
        tokenHash(refreshToken),
        REFRESH_TOKEN_TTL_SECONDS,
      ],
    );
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  };
}

export async function verifyMcpAccessToken(token: string): Promise<boolean> {
  if (config.MCP_ACCESS_TOKEN && timingSafeTextEqual(token, config.MCP_ACCESS_TOKEN)) {
    return true;
  }

  const result = await pool.query(
    `SELECT 1
       FROM mcp_oauth_tokens
      WHERE token_hash = $1
        AND token_type = 'access'
        AND resource = $2
        AND revoked_at IS NULL
        AND expires_at > NOW()`,
    [tokenHash(token), MCP_RESOURCE],
  );

  return result.rowCount === 1;
}

export function registerOAuthRoutes(app: Hono): void {
  const protectedResourceMetadata = {
    resource: MCP_RESOURCE,
    authorization_servers: [config.PUBLIC_BASE_URL],
    scopes_supported: [DEFAULT_SCOPE],
    bearer_methods_supported: ['header'],
  };

  const authorizationServerMetadata = {
    issuer: config.PUBLIC_BASE_URL,
    authorization_endpoint: `${config.PUBLIC_BASE_URL}/oauth/authorize`,
    token_endpoint: `${config.PUBLIC_BASE_URL}/oauth/token`,
    registration_endpoint: `${config.PUBLIC_BASE_URL}/oauth/register`,
    scopes_supported: [DEFAULT_SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };

  app.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata));
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata));
  app.get('/.well-known/oauth-authorization-server/mcp', (c) => c.json(authorizationServerMetadata));

  app.post('/oauth/register', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return oauthError('invalid_client_metadata', 'Request body must be valid JSON');
    }

    const redirectUris = parseStringArray(body.redirect_uris);
    if (!redirectUris || !redirectUris.every(validRedirectUri)) {
      return oauthError('invalid_redirect_uri', 'redirect_uris must contain valid HTTPS or loopback URLs');
    }

    const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
    const responseTypes = body.response_types ?? ['code'];
    const authMethod = body.token_endpoint_auth_method ?? 'none';

    if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code')) {
      return oauthError('invalid_client_metadata', 'authorization_code grant is required');
    }
    if (!Array.isArray(responseTypes) || !responseTypes.includes('code')) {
      return oauthError('invalid_client_metadata', 'code response type is required');
    }
    if (authMethod !== 'none') {
      return oauthError('invalid_client_metadata', 'Only public clients using token_endpoint_auth_method=none are supported');
    }

    const clientId = randomToken(24);
    const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : 'MCP client';

    await pool.query(
      `INSERT INTO mcp_oauth_clients
        (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, 'none')`,
      [clientId, clientName, JSON.stringify(redirectUris), JSON.stringify(grantTypes), JSON.stringify(responseTypes)],
    );

    c.header('Cache-Control', 'no-store');
    return c.json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: 'none',
    }, 201);
  });

  app.get('/oauth/authorize', async (c) => {
    const responseType = c.req.query('response_type');
    const clientId = c.req.query('client_id');
    const redirectUri = c.req.query('redirect_uri');
    const state = c.req.query('state');
    const codeChallenge = c.req.query('code_challenge');
    const codeChallengeMethod = c.req.query('code_challenge_method');
    const requestedScope = c.req.query('scope') || DEFAULT_SCOPE;
    const resource = c.req.query('resource') || MCP_RESOURCE;

    if (!clientId || !redirectUri) {
      return oauthError('invalid_request', 'client_id and redirect_uri are required');
    }

    const clientResult = await pool.query(
      'SELECT redirect_uris FROM mcp_oauth_clients WHERE client_id = $1',
      [clientId],
    );
    if (clientResult.rowCount !== 1) {
      return oauthError('unauthorized_client', 'Unknown OAuth client', 401);
    }

    const redirectUris = clientResult.rows[0].redirect_uris as string[];
    if (!redirectUris.includes(redirectUri)) {
      return oauthError('invalid_request', 'redirect_uri does not match the registered client');
    }

    if (responseType !== 'code') {
      return c.redirect(appendOAuthError(redirectUri, state, 'unsupported_response_type', 'Only response_type=code is supported'));
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return c.redirect(appendOAuthError(redirectUri, state, 'invalid_request', 'PKCE with code_challenge_method=S256 is required'));
    }
    if (resource !== MCP_RESOURCE) {
      return c.redirect(appendOAuthError(redirectUri, state, 'invalid_target', 'Requested resource is not supported'));
    }

    const scopes = requestedScope.split(/\s+/).filter(Boolean);
    if (scopes.some((scope) => scope !== DEFAULT_SCOPE)) {
      return c.redirect(appendOAuthError(redirectUri, state, 'invalid_scope', 'Unsupported scope requested'));
    }

    if (!oauthAdminAuthorized(c.req.header('Authorization'))) {
      c.header('WWW-Authenticate', 'Basic realm="Authorize ChatGPT for Google Health MCP", charset="UTF-8"');
      return c.text('Enter the MCP administrator credentials to authorize this ChatGPT connection.', 401);
    }

    const code = randomToken();
    await pool.query(
      `INSERT INTO mcp_oauth_codes
        (code_hash, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 * INTERVAL '1 second'))`,
      [tokenHash(code), clientId, redirectUri, codeChallenge, scopes.join(' '), resource, AUTHORIZATION_CODE_TTL_SECONDS],
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

    if (!clientId) return oauthError('invalid_client', 'client_id is required', 401);

    const clientResult = await pool.query(
      'SELECT 1 FROM mcp_oauth_clients WHERE client_id = $1',
      [clientId],
    );
    if (clientResult.rowCount !== 1) return oauthError('invalid_client', 'Unknown OAuth client', 401);

    if (grantType === 'authorization_code') {
      const code = typeof body.code === 'string' ? body.code : '';
      const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
      const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
      if (!code || !redirectUri || !codeVerifier) {
        return oauthError('invalid_request', 'code, redirect_uri, and code_verifier are required');
      }

      await pool.query('BEGIN');
      try {
        const codeResult = await pool.query(
          `SELECT client_id, redirect_uri, code_challenge, scope, resource
             FROM mcp_oauth_codes
            WHERE code_hash = $1
              AND used_at IS NULL
              AND expires_at > NOW()
            FOR UPDATE`,
          [tokenHash(code)],
        );

        if (codeResult.rowCount !== 1) {
          await pool.query('ROLLBACK');
          return oauthError('invalid_grant', 'Authorization code is invalid or expired');
        }

        const row = codeResult.rows[0];
        const calculatedChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
        if (row.client_id !== clientId || row.redirect_uri !== redirectUri || !timingSafeTextEqual(calculatedChallenge, row.code_challenge)) {
          await pool.query('ROLLBACK');
          return oauthError('invalid_grant', 'Authorization code validation failed');
        }

        await pool.query('UPDATE mcp_oauth_codes SET used_at = NOW() WHERE code_hash = $1', [tokenHash(code)]);
        await pool.query('COMMIT');
        const tokens = await issueTokenPair(clientId, row.scope, row.resource);
        return c.json(tokens, 200, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
    }

    if (grantType === 'refresh_token') {
      const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
      if (!refreshToken) return oauthError('invalid_request', 'refresh_token is required');

      const refreshResult = await pool.query(
        `SELECT client_id, scope, resource, family_id
           FROM mcp_oauth_tokens
          WHERE token_hash = $1
            AND token_type = 'refresh'
            AND revoked_at IS NULL
            AND expires_at > NOW()`,
        [tokenHash(refreshToken)],
      );
      if (refreshResult.rowCount !== 1 || refreshResult.rows[0].client_id !== clientId) {
        return oauthError('invalid_grant', 'Refresh token is invalid or expired');
      }

      const row = refreshResult.rows[0];
      await pool.query(
        'UPDATE mcp_oauth_tokens SET revoked_at = NOW() WHERE token_hash = $1',
        [tokenHash(refreshToken)],
      );
      const tokens = await issueTokenPair(clientId, row.scope, row.resource, row.family_id);
      return c.json(tokens, 200, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    }

    return oauthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
  });
}

export function mcpResourceMetadataUrl(): string {
  return `${config.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp`;
}
