import { describe, expect, it } from "vitest";
import { productionConfigErrors } from "../scripts/lib/production-config";
const env = {
  NODE_ENV: "production",
  LOCAL_PREVIEW: "0",
  APP_URL: "https://club.example.com",
  DATABASE_URL: "postgresql://rpm:synthetic@127.0.0.1:5432/rpm_club",
  SESSION_SECRET: "s".repeat(40),
  CRON_SECRET: "c".repeat(40),
  INTEGRATION_API_KEY: "i".repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  TELEGRAM_WEBHOOK_SECRET: "w".repeat(40),
  TELEGRAM_BOT_TOKEN: "123456:synthetic-token",
  TELEGRAM_BOT_USERNAME: "rpmclub_bot",
  MEDIA_DIR: "/var/lib/rpm-club/media",
};
describe("VPS startup configuration", () => {
  it("accepts configured production with isolated password-protected local Postgres", () => {
    expect(productionConfigErrors(env)).toEqual([]);
  });
  it("preserves valid existing unpadded base64 encryption keys", () => {
    expect(
      productionConfigErrors({
        ...env,
        ENCRYPTION_KEY: env.ENCRYPTION_KEY.replace(/=+$/, ""),
      }),
    ).toEqual([]);
  });
  it("rejects preview modes, non-HTTPS addresses and missing media storage", () => {
    const errors = productionConfigErrors({
      ...env,
      LOCAL_PREVIEW: "1",
      APP_URL: "http://localhost:3001",
      TELEGRAM_BOT_TOKEN: "",
      MEDIA_DIR: "",
    });
    for (const key of [
      "LOCAL_PREVIEW",
      "APP_URL",
      "TELEGRAM_BOT_TOKEN",
      "MEDIA_DIR",
    ])
      expect(errors.some((e) => e.includes(key))).toBe(true);
  });
  it("allows plaintext only for the explicitly isolated Docker database", () => {
    expect(
      productionConfigErrors({
        ...env,
        DATABASE_URL: "postgresql://rpm:synthetic@rpm-club-db/rpm_club",
        DATABASE_PRIVATE_NETWORK: "1",
      }),
    ).toEqual([]);
    expect(
      productionConfigErrors({
        ...env,
        DATABASE_URL: "postgresql://rpm:synthetic@remote.example.com/rpm_club",
        DATABASE_PRIVATE_NETWORK: "1",
      }).length,
    ).toBeGreaterThan(0);
  });
  it("rejects test/trust databases and unverified remote TLS without exposing secrets", () => {
    for (const DATABASE_URL of [
      "postgresql://rpm@localhost/rpm_club",
      "postgresql://rpm:private-password@localhost/rpm_club_test",
      "postgresql://rpm:private-password@remote.example.com/rpm_club?sslmode=no-verify",
    ]) {
      const errors = productionConfigErrors({ ...env, DATABASE_URL });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join(" ")).not.toContain("private-password");
    }
    expect(
      productionConfigErrors({
        ...env,
        DATABASE_URL:
          "postgresql://rpm:private-password@remote.example.com/rpm_club?sslmode=verify-full",
      }),
    ).toEqual([]);
  });
  it("rejects reused secrets and invalid encryption key lengths", () => {
    expect(
      productionConfigErrors({ ...env, CRON_SECRET: env.SESSION_SECRET }),
    ).toContain("Application secrets must be independent");
    expect(
      productionConfigErrors({ ...env, ENCRYPTION_KEY: "a".repeat(32) }).some(
        (e) => e.startsWith("ENCRYPTION_KEY"),
      ),
    ).toBe(true);
  });
});
