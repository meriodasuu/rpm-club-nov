import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import QRCode from "qrcode";

import type { Db } from "@/lib/db";
import { HttpError } from "@/lib/http";

function key() {
  const raw = process.env.ENCRYPTION_KEY ?? "";
  const value = Buffer.from(
    raw,
    /^[a-f0-9]{64}$/i.test(raw) ? "hex" : "base64",
  );
  if (value.length !== 32)
    throw new HttpError(503, "MFA_CONFIG", "Вход временно недоступен");
  return value;
}
function seal(secret: string, id: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(`rpm-staff-mfa:v1:${id}`));
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
function unseal(value: string, id: string) {
  const data = Buffer.from(value, "base64");
  const cipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  cipher.setAAD(Buffer.from(`rpm-staff-mfa:v1:${id}`));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([
    cipher.update(data.subarray(28)),
    cipher.final(),
  ]).toString("utf8");
}

// Call only after locking an active membership and its valid private bot link.
export async function prepareStaffEnrollment(
  tx: Db,
  membershipId: string,
  label: string,
  expiresAt: Date,
) {
  let [factor] = await tx.query<{
    secret_encrypted: string;
    verified_at: Date | null;
    enrollment_expires_at: Date;
  }>(
    "SELECT secret_encrypted,verified_at,enrollment_expires_at FROM staff_telegram_mfa WHERE membership_id=$1 FOR UPDATE",
    [membershipId],
  );
  if (factor?.verified_at) return { mfa_required: true };
  if (
    !factor ||
    new Date(factor.enrollment_expires_at).getTime() <= Date.now()
  ) {
    const secret = new Secret({ size: 20 }).base32;
    [factor] = await tx.query<typeof factor>(
      `INSERT INTO staff_telegram_mfa(membership_id,secret_encrypted,enrollment_expires_at) VALUES($1,$2,$3)
       ON CONFLICT(membership_id) DO UPDATE SET secret_encrypted=excluded.secret_encrypted,enrollment_expires_at=excluded.enrollment_expires_at,last_counter=-1 RETURNING *`,
      [membershipId, seal(secret, membershipId), expiresAt],
    );
  }
  const totp = new TOTP({
    issuer: "RPM Club",
    label,
    secret: unseal(factor.secret_encrypted, membershipId),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });
  return {
    mfa_required: true,
    enrollment: {
      manualKey: totp.secret.base32,
      qrCode: await QRCode.toDataURL(totp.toString(), {
        width: 220,
        margin: 2,
      }),
    },
  };
}

export async function verifyStaffCode(
  tx: Db,
  membershipId: string,
  otp: string,
) {
  const [factor] = await tx.query<{
    secret_encrypted: string;
    last_counter: string;
    verified_at: Date | null;
    enrollment_expires_at: Date;
  }>(
    "SELECT secret_encrypted,last_counter,verified_at,enrollment_expires_at FROM staff_telegram_mfa WHERE membership_id=$1 FOR UPDATE",
    [membershipId],
  );
  if (
    !factor ||
    (!factor.verified_at &&
      new Date(factor.enrollment_expires_at).getTime() <= Date.now())
  )
    throw new HttpError(
      403,
      "MFA_SETUP_REQUIRED",
      "Откройте действующую ссылку из бота и настройте Google Authenticator на странице входа.",
    );
  const totp = new TOTP({
    secret: unseal(factor.secret_encrypted, membershipId),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });
  const timestamp = Date.now();
  const delta = totp.validate({ token: otp, timestamp, window: 1 });
  const counter = Math.floor(timestamp / 30000) + (delta ?? 0);
  if (delta === null || counter <= Number(factor.last_counter))
    throw new HttpError(
      401,
      "MFA_INVALID",
      "Неверный или уже использованный код. Дождитесь нового кода в Google Authenticator.",
    );
  await tx.query(
    "UPDATE staff_telegram_mfa SET last_counter=$2,verified_at=COALESCE(verified_at,now()) WHERE membership_id=$1",
    [membershipId, counter],
  );
}
