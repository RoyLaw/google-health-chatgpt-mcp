import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  PUBLIC_BASE_URL: z.string().url().transform((value) => value.replace(/\/$/, '')),
  DATABASE_URL: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_SCOPES: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  MCP_ACCESS_TOKEN: z.string().min(32),
  OAUTH_ADMIN_USER: z.string().min(1),
  OAUTH_ADMIN_PASSWORD: z.string().min(16),
  TZ: z.string().default('Asia/Shanghai'),
});

export const config = schema.parse(process.env);
export const googleScopes = config.GOOGLE_SCOPES.split(/\s+/).filter(Boolean);
