import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, query } from "../src/lib/db";

const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;

suite("RPM Rent bot database boundary", () => {
  let userId = "";

  afterAll(closePool);

  it("searches a client, exposes rental history and grants one daily attempt", async () => {
    const telegramId = String(
      BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 11)),
    );
    const [user] = await query<{ id: string }>(
      "INSERT INTO users(name,phone,telegram_id,telegram_username,status) VALUES('Rent bot QA','+79990000001',$1,'rent_bot_qa','active') RETURNING id",
      [telegramId],
    );
    userId = user.id;
    await query(
      `INSERT INTO rentals(external_rental_id,user_id,source,car_name,start_date,end_date,amount_kopecks,current_amount_kopecks,status,payment_status,qualified_at,program_version_id,payload_hash,mode)
       VALUES($1,$2,'rpm-rent','QA Porsche','2026-10-01','2026-10-03',100000,100000,'accepted','unpaid',now(),(SELECT id FROM program_versions ORDER BY version DESC LIMIT 1),'rpm-rent-bot-qa','operational')`,
      ["rpm-rent-bot-" + randomUUID(), user.id],
    );

    const clients = await query<{
      user_id: string;
      blacklisted: boolean;
    }>("SELECT * FROM integration.find_clients($1,NULL,NULL,NULL)", [
      "@rent_bot_qa",
    ]);
    expect(clients).toEqual([
      expect.objectContaining({ user_id: user.id, blacklisted: false }),
    ]);

    const history = await query<{ user_id: string; car_name: string }>(
      "SELECT $1::uuid AS user_id,h.car_name FROM integration.client_rental_history($1,10) h",
      [user.id],
    );
    expect(history[0]).toMatchObject({ user_id: user.id, car_name: "QA Porsche" });

    const firstCredit = await query<{ granted: boolean; credit_id: string }>(
      "SELECT * FROM integration.grant_daily_roulette_attempt($1,'manager:qa','QA grant')",
      [user.id],
    );
    const secondCredit = await query<{ granted: boolean; credit_id: string }>(
      "SELECT * FROM integration.grant_daily_roulette_attempt($1,'manager:qa','QA grant')",
      [user.id],
    );
    expect(firstCredit[0]).toMatchObject({ granted: true });
    expect(secondCredit[0]).toEqual({
      granted: false,
      credit_id: firstCredit[0].credit_id,
      expires_at: expect.any(Date),
    });
  });

  it("audits blacklist changes and stores idempotent rental events", async () => {
    const blacklist = await query<{ blacklisted: boolean; changed: boolean }>(
      "SELECT * FROM integration.set_client_blacklist_status($1,true,'manager:qa','QA block')",
      [userId],
    );
    expect(blacklist[0]).toEqual({
      user_id: userId,
      account_status: "blocked",
      blacklisted: true,
      changed: true,
    });

    const eventKey = randomUUID();
    const eventArgs = [
      eventKey,
      userId,
      "rpm-rent-event-" + randomUUID(),
      "QA Porsche",
      "2026-10-01",
      "2026-10-03",
      "started",
      new Date().toISOString(),
      "manager",
      "manager:qa",
    ];
    const firstEvent = await query<{ event_id: string; duplicate: boolean }>(
      "SELECT * FROM integration.record_rental_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      eventArgs,
    );
    const repeatedEvent = await query<{ event_id: string; duplicate: boolean }>(
      "SELECT * FROM integration.record_rental_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      eventArgs,
    );
    expect(firstEvent[0]).toMatchObject({ duplicate: false });
    expect(repeatedEvent[0]).toMatchObject({
      event_id: firstEvent[0].event_id,
      duplicate: true,
    });
  });
});
