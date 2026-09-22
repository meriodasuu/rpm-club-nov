import { describe, expect, it } from 'vitest';
import { poolConfig } from '../src/lib/db/config';

describe('database TLS configuration', () => {
  it('keeps local database connections unchanged', () => {
    const config = poolConfig({ DATABASE_URL: 'postgresql://rpm@127.0.0.1/rpm_club' });
    expect(config.connectionString).toBe('postgresql://rpm@127.0.0.1/rpm_club');
    expect(config.ssl).toBeUndefined();
  });

  it('verifies the server using the configured CA even with conflicting URL parameters', () => {
    const ca = 'test certificate';
    const config = poolConfig({
      DATABASE_URL: 'postgresql://app:password@db.example/app?sslmode=no-verify&sslrootcert=other.pem&application_name=rpm',
      DATABASE_SSL_CA_BASE64: Buffer.from(ca).toString('base64'),
    });
    expect(config.ssl).toEqual({ ca, rejectUnauthorized: true });
    const url = new URL(config.connectionString!);
    expect(url.searchParams.has('sslmode')).toBe(false);
    expect(url.searchParams.has('sslrootcert')).toBe(false);
    expect(url.searchParams.get('application_name')).toBe('rpm');
  });
});
