import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, closePool } from "../src/lib/db";
import { clientRoute } from "../src/lib/api/client";
import { handle } from "../src/lib/http";
import { hashToken, randomToken } from "../src/lib/auth/session";
import { creditBonus } from "../src/lib/loyalty";

const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const base = "http://127.0.0.1:3001";
async function member() {
  const token = randomToken();
  const telegramId = BigInt(
    "0x" + randomUUID().replaceAll("-", "").slice(0, 11),
  ).toString();
  const [user] = await query<{ id: string }>(
    "INSERT INTO users(name,status,telegram_id) VALUES('History QA','active',$1) RETURNING id",
    [telegramId],
  );
  await query(
    "INSERT INTO miniapp_sessions(token_hash,user_id,telegram_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [hashToken(token), user.id, telegramId],
  );
  return { id: user.id, cookie: "rpm_session=" + token };
}
function call(cookie: string, search = "", path = "me/rentals") {
  const request = new Request(base + "/api/" + path + search, {
    headers: { cookie },
  });
  return handle(async () => (await clientRoute(request, path))!);
}
suite("rental history ownership and precise pagination", () => {
  let user: Awaited<ReturnType<typeof member>>,
    other: Awaited<ReturnType<typeof member>>;
  beforeAll(async () => {
    user = await member();
    other = await member();
    for (const account of [user, other]) {
      for (let index = 0; index < 5; index++) {
        await query(
          `INSERT INTO rentals(external_rental_id,user_id,source,car_name,start_date,end_date,amount_kopecks,current_amount_kopecks,status,payment_status,qualified_at,program_version_id,payload_hash,mode,created_at)
          VALUES($1,$2,'history-qa','History QA car','2026-09-01','2026-09-03',100000,92500,'accepted','unpaid',now(),(SELECT id FROM program_versions ORDER BY version DESC LIMIT 1),'qa','operational',$3)`,
          [randomUUID(), account.id, `2026-09-05T12:00:00.12345${index}Z`],
        );
      }
    }
  });
  afterAll(closePool);
  it("returns every own rental once when timestamps differ only by microseconds", async () => {
    const expected = await query<{ id: string }>(
      "SELECT id FROM rentals WHERE user_id=$1 ORDER BY created_at DESC,id DESC",
      [user.id],
    );
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const response = await call(
        user.cookie,
        "?limit=2" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      );
      expect(response.status).toBe(200);
      const result = await response.json();
      for (const rental of result.items) {
        expect(rental.user_id).toBe(user.id);
        expect(rental.current_amount_kopecks).toBe("92500");
        ids.push(rental.id);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toEqual(expected.map((row) => row.id));
    expect(new Set(ids).size).toBe(5);
    expect((await call("")).status).toBe(401);
    expect(
      (await (await call(other.cookie)).json()).items.every(
        (row: { user_id: string }) => row.user_id === other.id,
      ),
    ).toBe(true);
  });
  it("preserves calendar rental dates independently of server timezone", async () => {
    const result = await (await call(user.cookie)).json();
    expect(result.items[0]).toMatchObject({
      start_date: "2026-09-01",
      end_date: "2026-09-03",
    });
  });
  it("rejects malformed date and UUID cursors with a client error", async () => {
    for (const payload of [
      ...[
        "invalid",
        "2026-02-30T00:00:00Z",
        "2026-02-29T00:00:00Z",
        "0000-01-01T00:00:00Z",
        "2026-09-01T24:00:00Z",
      ].map((at) => ({ at, id: randomUUID() })),
      { at: "2026-09-01T00:00:00Z", id: "not-a-uuid" },
    ]) {
      const response = await call(
        user.cookie,
        "?cursor=" + Buffer.from(JSON.stringify(payload)).toString("base64url"),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_CURSOR" });
    }
  });
  it("keeps own bonus transactions and lot fields across pages", async () => {
    for (const account of [user, other]) {
      for (let i = 0; i < 3; i++)
        await creditBonus(
          {
            userId: account.id,
            amount: "100",
            reason: "History QA",
            idempotencyKey: randomUUID(),
          },
          { id: "history-qa", role: "admin" },
        );
    }
    const first = await (
      await call(user.cookie, "?limit=2", "me/transactions")
    ).json();
    expect(first.items).toHaveLength(2);
    const second = await (
      await call(
        user.cookie,
        "?limit=2&cursor=" + encodeURIComponent(first.nextCursor),
        "me/transactions",
      )
    ).json();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const items = [...first.items, ...second.items];
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
    for (const item of items) {
      expect(item).toMatchObject({
        user_id: user.id,
        amount: "100",
        remaining_amount: "100",
        type: "manual_credit",
      });
      expect(Date.parse(item.expires_at)).toBeGreaterThan(Date.now());
      expect(item).not.toHaveProperty("pagination_at");
    }
  });
});
