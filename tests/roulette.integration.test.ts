import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { query, closePool } from "../src/lib/db";
import { randomToken, hashToken } from "../src/lib/auth/session";
import { handle } from "../src/lib/http";
import { rouletteRoute } from "../src/lib/roulette";
import { reconcileRegistrationCredits } from "../src/lib/roulette/credits";
import { clubRoute } from "../src/lib/api/club";
import { moscowDate } from "../src/lib/club/contracts";

const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const base = "http://127.0.0.1:3001";
async function request(
  path: string,
  cookie: string,
  data?: unknown,
  key = randomUUID(),
  method = data === undefined ? "GET" : "POST",
) {
  const req = new Request(base + "/api/" + path, {
    method,
    headers: {
      cookie,
      origin: base,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return handle(
    async () =>
      (await rouletteRoute(req, path)) ??
      (await clubRoute(req, path)) ??
      new Response(null, { status: 404 }),
  );
}
suite("roulette database workflow", () => {
  afterAll(async () => {
    if (process.env.DATABASE_URL?.includes("rpm_club_test")) {
      await query(
        "UPDATE roulette_settings SET enabled=false,approved=false WHERE id=true",
      );
      await closePool();
    }
    vi.unstubAllEnvs();
  });
  it("serializes spins, assigns a claim code and redeems the prize once", async () => {
    vi.stubEnv("ROULETTE_ECONOMICS_APPROVED", "1");
    vi.stubEnv("APP_URL", base);
    const telegram = String(
      BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 11)),
    );
    const [user] = await query<{ id: string }>(
      "INSERT INTO users(name,status,telegram_id) VALUES('Roulette synthetic','active',$1) RETURNING id",
      [telegram],
    );
    const clientToken = randomToken();
    await query(
      "INSERT INTO miniapp_sessions(user_id,telegram_id,telegram_profile,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
      [
        user.id,
        telegram,
        JSON.stringify({ id: Number(telegram), first_name: "Test" }),
        hashToken(clientToken),
      ],
    );
    const clientCookie = "rpm_session=" + clientToken;
    const staffToken = randomToken(),
      authId = randomUUID();
    const [staff] = await query<{ id: string }>(
      "INSERT INTO admin_memberships(auth_user_id,name,email,role) VALUES($1,'Roulette test',$2,'admin') RETURNING id",
      [authId, authId + "@example.invalid"],
    );
    await query(
      "INSERT INTO staff_sessions(token_hash,membership_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [hashToken(staffToken), staff.id],
    );
    const staffCookie = "rpm_staff=" + staffToken;
    await query("UPDATE roulette_prizes SET active=false WHERE active");
    const create = await request("admin/roulette/prizes", staffCookie, {
      code: "Приз на русском",
      title: "Тестовая скидка",
      summary: "Синтетический приз",
      terms: "Только в тестовой базе",
      image_url: "/api/media/00000000-0000-4000-8000-000000000001.webp",
      image_alt: "Тестовый приз",
      effect_type: "percent",
      effect_value: 2500,
      minimum_tier: null,
      min_days: 1,
      max_days: 90,
      min_total_kopecks: "0",
      starts_at: null,
      ends_at: null,
      issue_cap: 1,
      active: true,
      sort_order: 0,
    });
    expect(create.status).toBe(200);
    const prize = await create.json();
    expect(prize.code).toMatch(/^prize-[a-f0-9]{32}$/);
    const [config] = await query<{ version: number }>("SELECT version FROM roulette_settings WHERE id=true");
    expect((await request("admin/roulette/settings", staffCookie, {
      enabled: true, approved: true, registration_attempts: 1, attempt_ttl_days: 30,
      award_ttl_days: 7, expected_version: config.version,
    }, randomUUID(), "PATCH")).status).toBe(200);
    expect((await request("admin/roulette/credits", staffCookie, {
      userId: user.id, amount: 1, reason: "Проверка ручной выдачи",
    })).status).toBe(201);
    const [newMember] = await query<{ id: string }>(
      "INSERT INTO users(name,status,telegram_id) VALUES('Roulette new member','active',$1) RETURNING id",
      [String(BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 11)))],
    );
    await reconcileRegistrationCredits();
    const [registrationCredit] = await query<{ granted: number }>(
      "SELECT granted FROM roulette_attempt_credits WHERE user_id=$1 AND source_type='registration'",
      [newMember.id],
    );
    expect(registrationCredit.granted).toBe(1);
    const promo = await request("admin/roulette/promos", staffCookie, {
      label: "Проверка промокода", startsAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxRedemptions: 1,
    });
    expect(promo.status).toBe(201);
    const promoCode = (await promo.json()).code;
    expect((await request("me/roulette/promos/redeem", clientCookie, { code: promoCode })).status).toBe(201);
    expect((await request("me/roulette/promos/redeem", clientCookie, { code: promoCode })).status).toBe(409);
    const keys = [randomUUID(), randomUUID()];
    const spins = await Promise.all(
      keys.map((key) => request("me/roulette/spins", clientCookie, {}, key)),
    );
    expect(spins.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = spins.findIndex((r) => r.status === 201);
    const result = await spins[winner].json();
    const replay = await request(
      "me/roulette/spins",
      clientCookie,
      {},
      keys[winner],
    );
    expect((await replay.json()).spinId).toBe(result.spinId);
    expect(result.award.claim_code).toMatch(/^RM-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/);
    expect(
      (
        await request(
          "admin/roulette/prizes/" + prize.id,
          staffCookie,
          {
            ...prize,
            title: "Изменённый приз",
            expected_version: prize.version,
          },
          randomUUID(),
          "PATCH",
        )
      ).status,
    ).toBe(200);
    const awards = await request("me/roulette/awards", clientCookie);
    expect(
      (await awards.json()).items.find(
        (a: { id: string }) => a.id === result.award.id,
      ).prize_snapshot.title,
    ).toBe("Тестовая скидка");
    const [car] = await query<{ id: string; version: number }>(
      "INSERT INTO club_content(kind,title,summary,body,daily_price_kopecks,active) VALUES('car','Synthetic car','','','100000',true) RETURNING id,version",
    );
    const startDate = moscowDate(new Date(Date.now() + 10 * 86400000));
    const endDate = moscowDate(new Date(Date.now() + 12 * 86400000));
    const quoteResponse = await request("me/rental-quotes", clientCookie, {
      carId: car.id,
      startDate,
      endDate,
      awardIds: [result.award.id],
    });
    expect(quoteResponse.status).toBe(200);
    const offerCombo = await request("me/rental-quotes", clientCookie, {
      carId: car.id,
      startDate,
      endDate,
      awardIds: [result.award.id],
      offerId: randomUUID(),
    });
    expect(offerCombo.status).toBe(422);
    expect(await offerCombo.json()).toMatchObject({ code: "AWARD_WITH_OFFER" });
    const quote = await quoteResponse.json();
    expect(quote.awards[0].id).toBe(result.award.id);
    const requestResponse = await request("me/rental-requests", clientCookie, {
      carId: car.id,
      startDate,
      endDate,
      comment: "",
      awardIds: [result.award.id],
      expectedTotal: quote.totalKopecks,
      expectedCarVersion: quote.carVersion,
      expectedProgramId: quote.programId,
    });
    expect(requestResponse.status).toBe(201);
    const bookingRequest = await requestResponse.json();
    const [reserved] = await query<{ status: string; reserved_request_id: string }>(
      "SELECT status,reserved_request_id FROM roulette_awards WHERE id=$1", [result.award.id],
    );
    expect(reserved).toMatchObject({ status: "reserved", reserved_request_id: bookingRequest.id });
    const visible = await request("admin/rental-requests", staffCookie);
    expect((await visible.json()).items.find((item: { id: string }) => item.id === bookingRequest.id).roulette_awards[0].claim_code).toBe(result.award.claim_code);
    expect((await request(`me/rental-requests/${bookingRequest.id}/cancel`, clientCookie, {})).status).toBe(200);
    const [released] = await query<{ status: string; reserved_request_id: string | null }>(
      "SELECT status,reserved_request_id FROM roulette_awards WHERE id=$1", [result.award.id],
    );
    expect(released).toMatchObject({ status: "available", reserved_request_id: null });
    const history = await request(`admin/roulette/awards?userId=${user.id}`, staffCookie);
    expect(history.status).toBe(200);
    expect((await history.json()).items[0].claim_code).toBe(result.award.claim_code);
    const redeemPath = `admin/roulette/awards/${result.award.id}/redeem`;
    expect((await request(redeemPath, staffCookie, {})).status).toBe(200);
    expect((await request(redeemPath, staffCookie, {})).status).toBe(409);
    const [redeemed] = await query<{ status: string; redeemed_by: string }>(
      "SELECT status,redeemed_by FROM roulette_awards WHERE id=$1", [result.award.id],
    );
    expect(redeemed).toMatchObject({ status: "redeemed", redeemed_by: staff.id });
  });
});
