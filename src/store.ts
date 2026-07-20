import crypto from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.DATABASE_URL });

function key(): Buffer {
  return crypto.createHash('sha256').update(config.TOKEN_ENCRYPTION_KEY).digest();
}

export function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((v) => v.toString('base64url')).join('.');
}

export function decrypt(value: string): string {
  const [ivText, tagText, encryptedText] = value.split('.');
  if (!ivText || !tagText || !encryptedText) throw new Error('Invalid encrypted token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export type StoredToken = {
  refreshToken: string;
  accessToken: string | null;
  expiresAt: Date | null;
  scopes: string | null;
};

export async function saveGoogleToken(input: {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: Date;
  scopes?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO oauth_tokens(provider, encrypted_refresh_token, access_token, expires_at, scopes)
     VALUES ('google', $1, $2, $3, $4)
     ON CONFLICT(provider) DO UPDATE SET
       encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
       access_token = EXCLUDED.access_token,
       expires_at = EXCLUDED.expires_at,
       scopes = EXCLUDED.scopes,
       updated_at = NOW()`,
    [encrypt(input.refreshToken), input.accessToken ?? null, input.expiresAt ?? null, input.scopes ?? null],
  );
}

export async function loadGoogleToken(): Promise<StoredToken | null> {
  const result = await pool.query(
    `SELECT encrypted_refresh_token, access_token, expires_at, scopes
       FROM oauth_tokens WHERE provider = 'google'`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    refreshToken: decrypt(row.encrypted_refresh_token),
    accessToken: row.access_token,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    scopes: row.scopes,
  };
}

export async function updateAccessToken(accessToken: string, expiresAt: Date): Promise<void> {
  await pool.query(
    `UPDATE oauth_tokens SET access_token = $1, expires_at = $2, updated_at = NOW()
      WHERE provider = 'google'`,
    [accessToken, expiresAt],
  );
}

export async function audit(action: string, detail: unknown): Promise<void> {
  await pool.query('INSERT INTO audit_log(action, detail) VALUES ($1, $2)', [action, detail]);
}
