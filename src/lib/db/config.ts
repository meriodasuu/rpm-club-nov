import type { PoolConfig } from 'pg';

export function poolConfig(env: Record<string, string | undefined>): PoolConfig {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  let connectionString = env.DATABASE_URL;
  const ca = env.DATABASE_SSL_CA_BASE64;
  if (ca) {
    // pg URL SSL options override the explicit SSL object; keep our verified CA.
    const url = new URL(connectionString);
    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) url.searchParams.delete(key);
    connectionString = url.href;
  }
  return {
    connectionString,
    max: 12,
    connectionTimeoutMillis: 5000,
    ...(ca ? { ssl: { ca: Buffer.from(ca, 'base64').toString('utf8'), rejectUnauthorized: true } } : {}),
  };
}
