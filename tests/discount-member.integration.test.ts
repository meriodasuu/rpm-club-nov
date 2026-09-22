import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closePool, query } from "../src/lib/db";
import {
  getProgram,
  publishProgram,
  processRental,
  creditBonus,
  getAccountSnapshot,
} from "../src/lib/loyalty";
import { telegramMessage, type OutboxEvent } from "../src/lib/jobs/telegram";
import {
  notificationRules,
  scheduleNotifications,
  sendNotification,
} from "../src/lib/notifications/engine";
import { defaultNotification } from "../src/lib/notifications/contracts";

const suite = process.env.DATABASE_URL?.includes("/rpm_club_test")
  ? describe
  : describe.skip;
const actor = { id: "discount-member-qa", role: "admin" as const };
afterAll(closePool);

suite("discount member experience", () => {
  it("publishes discounts without rewriting past rentals, balances or rates", async () => {
    const previous = await getProgram();
    const telegram = String(
      BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 12)),
    );
    const [user] = await query<{ id: string }>(
      "INSERT INTO users(name,status,telegram_id) VALUES('Discount QA','active',$1) RETURNING id",
      [telegram],
    );
    await query(
      "UPDATE loyalty_accounts SET member_since=now()-interval '1 day' WHERE user_id=$1",
      [user.id],
    );
    const rental = {
      userId: user.id,
      externalRentalId: randomUUID(),
      carName: "Discount QA",
      startDate: "2026-09-01",
      endDate: "2026-09-02",
      status: "completed" as const,
      paymentStatus: "paid" as const,
      amountKopecks: "100000",
      idempotencyKey: randomUUID(),
    };
    await creditBonus(
      {
        userId: user.id,
        amount: "125",
        reason: "prior balance",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    const old = await processRental(rental, actor);
    const oldRows = await query("SELECT * FROM rentals WHERE id=$1", [
      old.rentalId,
    ]);
    const balance = (await getAccountSnapshot(user.id)).bonus_available;
    try {
      const published = await publishProgram(
        {
          ...previous,
          rewardMode: "discount",
          redemptionLimitBps: 0,
          referrerReward: "0",
          referredReward: "0",
          reason: "discount QA activation",
          idempotencyKey: randomUUID(),
        },
        actor,
      );
      expect(published.tiers).toEqual(previous.tiers);
      expect(
        await query("SELECT * FROM rentals WHERE id=$1", [old.rentalId]),
      ).toEqual(oldRows);
      const next = await processRental(
        {
          ...rental,
          externalRentalId: randomUUID(),
          idempotencyKey: randomUUID(),
        },
        actor,
      );
      expect(next.bonus).toBe("0");
      expect(next.snapshot.bonus_available).toBe(balance);
      expect(next.snapshot.discount_rate_bps).toBe(
        published.tiers.find((t) => t.code === next.snapshot.tier)!.rateBps,
      );
      expect(next.snapshot.cashback_rate_bps).toBe(0);
      const event: OutboxEvent = {
        id: randomUUID(),
        event_key: "discount-qa",
        event_type: "TIER_CHANGED",
        user_id: user.id,
        aggregate_id: user.id,
        account_version: next.snapshot.account_version,
        payload: { notify: true },
        created_at: new Date().toISOString(),
      };
      // Legacy balances must not reintroduce bonus copy into card notifications.
      const message = await telegramMessage(event, telegram);
      expect(message).toContain("Скидка по вашей карте");
      expect(message).not.toMatch(/bonus|cashback|бонус|к[еэ]шб[еэ]к/i);
    } finally {
      await publishProgram(
        {
          ...previous,
          reason: "restore discount member QA",
          idempotencyKey: randomUUID(),
        },
        actor,
      );
      await query("UPDATE users SET status='blocked' WHERE id=$1", [user.id]);
    }
  });

  it("cancels already queued bonus reminders and does not schedule new ones after activation", async () => {
    const previous = await getProgram();
    const rules = await notificationRules();
    const telegram = String(
      BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 12)),
    );
    const [user] = await query<{ id: string }>(
      "INSERT INTO users(name,status,telegram_id,marketing_consent) VALUES('Discount reminders QA','active',$1,true) RETURNING id",
      [telegram],
    );
    await query(
      "UPDATE loyalty_accounts SET member_since=now()-interval '1 day' WHERE user_id=$1",
      [user.id],
    );
    try {
      await query(
        "UPDATE notification_rules SET config=jsonb_set(config,'{enabled}','false')",
      );
      await query(
        "UPDATE notification_rules SET config=$1,enabled_at=now()-interval '1 minute' WHERE id='PROMO_01'",
        [
          JSON.stringify({
            ...defaultNotification("PROMO_01"),
            enabled: true,
            delayMinutes: 0,
          }),
        ],
      );
      await creditBonus(
        {
          userId: user.id,
          amount: "250",
          reason: "prior promotion",
          idempotencyKey: randomUUID(),
        },
        actor,
      );
      await scheduleNotifications(500);
      const [run] = await query<{ id: string }>(
        "SELECT id FROM notification_runs WHERE user_id=$1 AND trigger_id='PROMO_01'",
        [user.id],
      );
      expect(run).toBeDefined();
      await publishProgram(
        {
          ...previous,
          rewardMode: "discount",
          reason: "stop bonus reminders QA",
          idempotencyKey: randomUUID(),
        },
        actor,
      );
      let sent = false;
      expect(
        await sendNotification(run.id, async () => {
          sent = true;
        }),
      ).toBe("cancelled");
      expect(sent).toBe(false);
      await creditBonus(
        {
          userId: user.id,
          amount: "50",
          reason: "legacy correction",
          idempotencyKey: randomUUID(),
        },
        actor,
      );
      expect(await scheduleNotifications(500)).toBe(0);
      expect(
        (
          await query("SELECT id FROM notification_runs WHERE user_id=$1", [
            user.id,
          ])
        ).length,
      ).toBe(1);
    } finally {
      await publishProgram(
        {
          ...previous,
          reason: "restore reminders QA",
          idempotencyKey: randomUUID(),
        },
        actor,
      );
      for (const r of rules)
        await query(
          "UPDATE notification_rules SET config=$2,version=$3,enabled_at=$4 WHERE id=$1",
          [r.id, JSON.stringify(r.config), r.version, r.enabled_at],
        );
      await query("UPDATE users SET status='blocked' WHERE id=$1", [user.id]);
    }
  });
});
