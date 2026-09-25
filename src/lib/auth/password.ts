import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { HttpError } from "@/lib/http";

// OWASP scrypt profile: N=2^16, r=8, p=2 (64 MiB). Bound concurrent work on the VPS.
let running = 0;
async function derive(password: string, salt: string): Promise<Buffer> {
  if (running >= 2)
    throw new HttpError(
      429,
      "LOGIN_BUSY",
      "Вход занят. Повторите через несколько секунд.",
    );
  running++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        Buffer.from(salt, "hex"),
        32,
        { N: 65536, r: 8, p: 2, maxmem: 96 * 1024 * 1024 },
        (error, result) => (error ? reject(error) : resolve(result)),
      );
    });
  } finally {
    running--;
  }
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
const dummy = `scrypt-v1$${randomBytes(16).toString("hex")}$${"0".repeat(64)}`;
export async function verifyPassword(password: string, stored?: string) {
  const match = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(
    stored ?? dummy,
  );
  if (!match)
    throw new HttpError(503, "PASSWORD_CONFIG", "Вход временно недоступен");
  const actual = await derive(password, match[1]);
  return (
    timingSafeEqual(actual, Buffer.from(match[2], "hex")) && Boolean(stored)
  );
}
