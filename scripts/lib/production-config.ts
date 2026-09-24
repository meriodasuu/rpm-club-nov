import { isIP } from "node:net";

type Environment = Record<string, string | undefined>;

// Return field names/reasons only: startup logs must never contain credentials.
export function productionConfigErrors(env: Environment): string[] {
  const errors: string[] = [];
  if (env.NODE_ENV !== "production") errors.push("NODE_ENV must be production");
  if (env.LOCAL_PREVIEW !== "0") errors.push("LOCAL_PREVIEW must be 0");
  try {
    const url = new URL(env.APP_URL ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.port && url.port !== "443") ||
      isIP(url.hostname) ||
      !url.hostname.includes(".") ||
      /\.(localhost|local|internal|invalid)$/.test(url.hostname)
    )
      throw new Error();
  } catch {
    errors.push(
      "APP_URL must be a public HTTPS origin without a path or credentials",
    );
  }
  for (const key of [
    "SESSION_SECRET",
    "CRON_SECRET",
    "INTEGRATION_API_KEY",
  ] as const) {
    if ((env[key]?.length ?? 0) < 32)
      errors.push(`${key} must contain at least 32 characters`);
  }
  const encryption = env.ENCRYPTION_KEY ?? "";
  if (
    !/^[0-9a-f]{64}$/i.test(encryption) &&
    !(
      /^[A-Za-z0-9+/]{43}=?$/.test(encryption) &&
      Buffer.from(encryption, "base64").length === 32
    )
  )
    errors.push("ENCRYPTION_KEY must encode 32 bytes as base64 or hex");
  const secrets = [
    "SESSION_SECRET",
    "CRON_SECRET",
    "INTEGRATION_API_KEY",
    "ENCRYPTION_KEY",
    "TELEGRAM_WEBHOOK_SECRET",
  ]
    .map((k) => env[k])
    .filter(Boolean);
  if (new Set(secrets).size !== secrets.length)
    errors.push("Application secrets must be independent");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN ?? ""))
    errors.push("TELEGRAM_BOT_TOKEN is missing or invalid");
  if (!/^[A-Za-z0-9_]{5,32}$/.test(env.TELEGRAM_BOT_USERNAME ?? ""))
    errors.push("TELEGRAM_BOT_USERNAME must be set without @");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET ?? ""))
    errors.push(
      "TELEGRAM_WEBHOOK_SECRET must contain 32 to 256 URL-safe characters",
    );
  try {
    const db = new URL(env.DATABASE_URL ?? "");
    if (
      !["postgres:", "postgresql:"].includes(db.protocol) ||
      !db.hostname ||
      !db.username ||
      !db.password ||
      db.pathname.length <= 1 ||
      /(?:^|[_-])(test|dev)(?:$|[_-])/i.test(db.pathname.slice(1))
    )
      throw new Error();
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(db.hostname);
    if (
      !local &&
      !env.DATABASE_SSL_CA_BASE64 &&
      db.searchParams.get("sslmode") !== "verify-full"
    )
      errors.push(
        "Remote DATABASE_URL requires DATABASE_SSL_CA_BASE64 or sslmode=verify-full",
      );
    if (
      env.DATABASE_SSL_CA_BASE64 &&
      !Buffer.from(env.DATABASE_SSL_CA_BASE64, "base64")
        .toString()
        .includes("-----BEGIN CERTIFICATE-----")
    )
      errors.push(
        "DATABASE_SSL_CA_BASE64 must contain a base64 PEM certificate",
      );
  } catch {
    errors.push(
      "DATABASE_URL must point to a non-test PostgreSQL database with password authentication",
    );
  }
  try {
    const url = new URL(env.SUPABASE_URL ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error();
  } catch {
    errors.push("SUPABASE_URL must be an HTTPS origin");
  }
  for (const key of [
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
  ] as const)
    if (!env[key]?.trim())
      errors.push(`${key} is required for configured Auth/Storage`);
  return errors;
}
