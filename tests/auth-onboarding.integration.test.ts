import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { closePool, query } from "../src/lib/db";
import { authRoute } from "../src/lib/auth/routes";
import { hashToken, randomToken } from "../src/lib/auth/session";
import { handle } from "../src/lib/http";

const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const origin = "http://127.0.0.1:3001";
const secret = "synthetic-contact-webhook-secret";
const fixtureDocuments: string[] = [];

async function call(path: string, data: object, cookie = "") {
  return handle(
    async () =>
      (await authRoute(
        new Request(origin + "/api/" + path, {
          method: "POST",
          headers: {
            origin,
            cookie,
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": secret,
          },
          body: JSON.stringify(data),
        }),
        path,
      ))!,
  );
}

suite("verified private contacts enable onboarding notifications", () => {
  beforeAll(async () => {
    vi.stubEnv("APP_URL", origin);
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", secret);
    for (const type of ["rules", "privacy", "personal-data"]) {
      const existing = await query(
        "SELECT id FROM legal_documents WHERE type=$1 AND published_at<=now() LIMIT 1",
        [type],
      );
      if (!existing.length) {
        const [document] = await query<{ id: string }>(
          "INSERT INTO legal_documents(type,version,title,body) VALUES($1,$2,'Synthetic onboarding document','Synthetic content for contact verification regression') RETURNING id",
          [type, randomUUID()],
        );
        fixtureDocuments.push(document.id);
      }
    }
  });
  afterAll(async () => {
    if (fixtureDocuments.length) {
      await query(
        "DELETE FROM consent_acceptances WHERE document_id=ANY($1::uuid[])",
        [fixtureDocuments],
      );
      await query("DELETE FROM legal_documents WHERE id=ANY($1::uuid[])", [
        fixtureDocuments,
      ]);
    }
    vi.unstubAllEnvs();
    await closePool();
  });

  it.each([false, true])(
    "preserves confirmed chat access for existing profile=%s",
    async (existing) => {
      const telegramId = BigInt(
        "0x" + randomUUID().replaceAll("-", "").slice(0, 11),
      ).toString();
      const phone = "+7" + telegramId.padStart(10, "0").slice(-10);
      let expectedUserId: string | undefined;
      if (existing) {
        const [user] = await query<{ id: string }>(
          "INSERT INTO users(name,phone,status,telegram_reachable) VALUES('Contact QA',$1,'pending',false) RETURNING id",
          [phone],
        );
        expectedUserId = user.id;
      }
      const token = randomToken();
      const [session] = await query<{ id: string }>(
        "INSERT INTO miniapp_sessions(token_hash,telegram_id,telegram_profile,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') RETURNING id",
        [
          hashToken(token),
          telegramId,
          JSON.stringify({ id: Number(telegramId), first_name: "Contact QA" }),
        ],
      );
      const cookie = "rpm_session=" + token;
      expect((await call("me/contact-request", {}, cookie)).status).toBe(200);
      expect(
        (
          await call("telegram/webhook", {
            update_id: Number(telegramId),
            message: {
              from: { id: Number(telegramId) },
              chat: { id: Number(telegramId), type: "private" },
              contact: { user_id: Number(telegramId), phone_number: phone },
            },
          })
        ).status,
      ).toBe(200);
      const [contact] = await query<{ phone: string }>(
        "SELECT phone FROM contact_requests WHERE session_id=$1 AND consumed_at IS NOT NULL",
        [session.id],
      );
      expect(contact.phone).toBe(phone);
      const documents = await query<{ id: string }>(
        "SELECT DISTINCT ON(type) id FROM legal_documents WHERE published_at<=now() ORDER BY type,published_at DESC",
      );
      expect(documents).toHaveLength(3);
      const response = await call(
        "me/activate",
        { documentIds: documents.map((d) => d.id), marketingConsent: false },
        cookie,
      );
      expect(response.status).toBe(200);
      const result = await response.json();
      if (expectedUserId) expect(result.userId).toBe(expectedUserId);
      const [user] = await query(
        "SELECT status,telegram_reachable,marketing_consent FROM users WHERE id=$1",
        [result.userId],
      );
      expect(user).toMatchObject({
        status: "active",
        telegram_reachable: true,
        marketing_consent: false,
      });
    },
  );
});
