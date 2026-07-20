import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(8787),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_SCOPES: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  MCP_ACCESS_TOKEN: z.string().min(32),
  TZ: z.string().default('Asia/Shanghai'),
});

export const config = schema.parse(process.env);
export const googleScopes = config.GOOGLE_SCOPES.split(/\s+/).filter(Boolean);
