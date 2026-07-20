import crypto from 'node:crypto';
import { serve } from '@hono/node-server';
import { StreamableHTTPTransport } from '@hono/mcp';
import { Hono } from 'hono';
import { config } from './config.js';
import { createAuthorizationUrl, exchangeAuthorizationCode } from './google.js';
import { buildMcpServer } from './mcp.js';
import { pool } from './store.js';

const app = new Hono();

function tokenMatches(value: string, expected: string): boolean {
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
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return tokenMatches(username, config.OAUTH_ADMIN_USER)
      && tokenMatches(password, config.OAUTH_ADMIN_PASSWORD);
  } catch {
    return false;
  }
}

app.get('/health', async (c) => {
  try {
    await pool.query('SELECT 1');
    return c.json({ status: 'ok', service: 'google-health-chatgpt-mcp', mcp: '/mcp' });
  } catch {
    return c.json({ status: 'degraded', database: 'unavailable' }, 503);
  }
});

app.use('/oauth/google/*', async (c, next) => {
  if (!oauthAdminAuthorized(c.req.header('Authorization'))) {
    c.header('WWW-Authenticate', 'Basic realm="Google Health MCP administration", charset="UTF-8"');
    return c.text('Administrator authentication required', 401);
  }
  await next();
});

app.get('/oauth/google/start', (c) => c.redirect(createAuthorizationUrl()));

app.get('/oauth/google/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  if (error) return c.text(`Google authorization failed: ${error}`, 400);
  if (!code || !state) return c.text('Missing OAuth code or state', 400);
  try {
    await exchangeAuthorizationCode(code, state);
    return c.html('<h1>Google Health 已授权</h1><p>可以关闭此页面并开始使用 MCP。</p>');
  } catch (cause) {
    console.error(cause);
    return c.text(cause instanceof Error ? cause.message : String(cause), 500);
  }
});

app.use('/mcp', async (c, next) => {
  const authorization = c.req.header('Authorization');
  const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!supplied || !tokenMatches(supplied, config.MCP_ACCESS_TOKEN)) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'unauthorized' }, 401);
  }
  c.header('Cache-Control', 'no-store');
  await next();
});

app.all('/mcp', async (c) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  return response ?? c.body(null, 200);
});

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: 'internal_error', message: error.message }, 500);
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Google Health MCP listening on http://0.0.0.0:${info.port}`);
});
