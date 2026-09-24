import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { query, transaction, closePool } from "../src/lib/db";
import { processRental, creditBonus, debitBonus } from "../src/lib/loyalty";
import { ProviderError } from "../src/lib/jobs/provider";
import {
  notificationRules,
  scheduleNotifications,
  sendNotification,
  recordActivity,
} from "../src/lib/notifications/engine";
import {
  defaultNotification,
  notificationIds,
  blockedNotifications,
  type NotificationId,
  type NotificationRule,
} from "../src/lib/notifications/contracts";
import { notificationsRoute } from "../src/lib/notifications/api";
import { clubRoute } from "../src/lib/api/club";
import { reserveNotificationSlot } from "../src/lib/notifications/budget";
import { handle } from "../src/lib/http";
import { randomToken, hashToken } from "../src/lib/auth/session";
const suite = process.env.DATABASE_URL?.includes("/rpm_club_test")
  ? describe
  : describe.skip;
const actor = { id: "notifications-test", role: "admin" as const };
suite("lifecycle notifications on real PostgreSQL", () => {
  let previous: NotificationRule[],
    started: string,
    userId: string,
    telegram: string,
    cookie: string;
  const users: string[] = [];
  beforeAll(async () => {
    previous = await notificationRules();
    started = new Date().toISOString();
  });
  beforeEach(async () => {
    await query(
      "UPDATE notification_rules SET config=jsonb_set(config,'{enabled}','false')",
    );
    telegram = String(
      BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 12)),
    );
    const [u] = await query<{ id: string }>(
      "INSERT INTO users(name,status,telegram_id,telegram_reachable,marketing_consent) VALUES('Notification QA','active',$1,true,true) RETURNING id",
      [telegram],
    );
    userId = u.id;
    users.push(userId);
    await query(
      "UPDATE loyalty_accounts SET member_since=now()-interval '2 days' WHERE user_id=$1",
      [userId],
    );
    const token = randomToken();
    cookie = "rpm_session=" + token;
    await query(
      "INSERT INTO miniapp_sessions(token_hash,user_id,telegram_id,telegram_profile,expires_at) VALUES($1,$2,$3,'{" +
        '"allows_write_to_pm":true' +
        "}',now()+interval '1 day')",
      [hashToken(token), userId, telegram],
    );
  });
  afterAll(async () => {
    await query("DELETE FROM notification_runs WHERE created_at>=$1", [
      started,
    ]);
    for (const r of previous)
      await query(
        "UPDATE notification_rules SET config=$2,version=$3,enabled_at=$4 WHERE id=$1",
        [r.id, JSON.stringify(r.config), r.version, r.enabled_at],
      );
    await query("UPDATE users SET status='blocked' WHERE id=ANY($1::uuid[])", [
      users,
    ]);
    await closePool();
  });
  async function enable(id: NotificationId, extra = {}) {
    await query(
      "UPDATE notification_rules SET config=$2,enabled_at=now()-interval '1 day' WHERE id=$1",
      [
        id,
        JSON.stringify({
          ...defaultNotification(id),
          enabled: true,
          delayMinutes: 0,
          ...extra,
        }),
      ],
    );
  }
  async function ride() {
    return processRental(
      {
        userId,
        externalRentalId: randomUUID(),
        carName: "Notification QA",
        startDate: "2026-09-01",
        endDate: "2026-09-02",
        status: "completed",
        paymentStatus: "paid",
        amountKopecks: "100000",
        idempotencyKey: randomUUID(),
        mode: "operational",
      },
      actor,
    );
  }
  async function runs(id: NotificationId) {
    return query<{ id: string; reason: string; status: string }>(
      "SELECT * FROM notification_runs WHERE trigger_id=$1 AND user_id=$2 ORDER BY created_at",
      [id, userId],
    );
  }
  async function api(path: string, input?: unknown, auth = cookie) {
    return handle(
      async () =>
        (await (path.startsWith("me/rental-") ? clubRoute : notificationsRoute)(
          new Request(
            (process.env.APP_URL ?? "http://127.0.0.1:3000") + "/api/" + path,
            {
              method: input ? "POST" : "GET",
              headers: {
                cookie: auth,
                origin: process.env.APP_URL ?? "http://127.0.0.1:3000",
                "Content-Type": "application/json",
                "idempotency-key":
                  (input as { requestKey?: string })?.requestKey ??
                  randomUUID(),
              },
              ...(input ? { body: JSON.stringify(input) } : {}),
            },
          ),
          path.split("?")[0],
        )) ?? new Response(null, { status: 404 }),
    );
  }
  it("executes every applicable source, never enables absent payment/card flows, and stores unsendable events", async () => {
    await ride();
    await ride();
    await creditBonus(
      {
        userId,
        amount: "500",
        reason: "QA promo",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    await recordActivity({
      telegramId: telegram,
      userId,
      registered: true,
      canMessage: true,
    });
    for (const id of notificationIds)
      if (!blockedNotifications[id])
        await enable(id, { nearAmountKopecks: "999999999999" });
    await expect(scheduleNotifications(10000)).resolves.toBeGreaterThan(0);
    const send = vi
      .fn<
        (
          target: string,
          text: string,
          url: string,
          cta: string,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    const first = (await runs("RIDE_01"))[0];
    expect(first).toBeTruthy();
    await query("UPDATE users SET telegram_reachable=false WHERE id=$1", [
      userId,
    ]);
    expect(await sendNotification(first.id, send)).toBe("cancelled");
    expect(send).not.toHaveBeenCalled();
    expect((await runs("RIDE_01"))[0].reason).toBe("CHANNEL_UNAVAILABLE");
  });
  it("sends once under concurrency, substitutes current values, links to screen and respects the daily limit", async () => {
    await enable("RIDE_01");
    await ride();
    await scheduleNotifications();
    const first = (await runs("RIDE_01"))[0];
    const send = vi
      .fn<
        (
          target: string,
          text: string,
          url: string,
          cta: string,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    await Promise.all([
      sendNotification(first.id, send),
      sendNotification(first.id, send),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    const url = new URL(send.mock.calls[0][2] as string);
    expect(url.pathname).toBe("/club");
    expect(url.searchParams.get("notification")).toBe(first.id);
    await enable("RIDE_02");
    await ride();
    await scheduleNotifications();
    const second = (await runs("RIDE_02"))[0];
    expect(await sendNotification(second.id, send)).toBe("deferred");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("cancels after action, disables marketing, checks live bonus residue and cooldown", async () => {
    await enable("PROMO_01", { category: "marketing", cooldownHours: 168 });
    const a = await creditBonus(
      { userId, amount: "20", reason: "QA", idempotencyKey: randomUUID() },
      actor,
    );
    await scheduleNotifications();
    const p = (await runs("PROMO_01"))[0];
    await query("UPDATE users SET marketing_consent=false WHERE id=$1", [
      userId,
    ]);
    const send = vi
      .fn<
        (
          target: string,
          text: string,
          url: string,
          cta: string,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    expect(await sendNotification(p.id, send)).toBe("cancelled");
    await query(
      "UPDATE bonus_lots SET expires_at=now()+interval '23 hours' WHERE credit_transaction_id=$1",
      [a.transactionId],
    );
    await enable("EXP_02");
    await query("UPDATE users SET marketing_consent=true WHERE id=$1", [
      userId,
    ]);
    await scheduleNotifications();
    const e = (await runs("EXP_02"))[0];
    expect(e).toBeTruthy();
    await debitBonus(
      {
        userId,
        amount: "20",
        type: "manual_debit",
        reason: "QA spent balance",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    expect(await sendNotification(e.id, send)).toBe("cancelled");
    expect(send).not.toHaveBeenCalled();
  });
  it("tracks registration before membership and cancels after completion", async () => {
    const id = "tg:" + telegram;
    await query("UPDATE users SET status='pending' WHERE id=$1", [userId]);
    await recordActivity({
      telegramId: telegram,
      userId: null,
      registered: false,
      canMessage: true,
    });
    await enable("REG_01");
    await scheduleNotifications();
    const [r] = await query<{ id: string }>(
      "SELECT id FROM notification_runs WHERE identity_key=$1 AND trigger_id=$2",
      [id, "REG_01"],
    );
    expect(r).toBeTruthy();
    await query("UPDATE users SET status='active' WHERE id=$1", [userId]);
    const send = vi
      .fn<
        (
          target: string,
          text: string,
          url: string,
          cta: string,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    expect(await sendNotification(r.id, send)).toBe("cancelled");
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["blocked", "unreachable", "disabled"] as const)(
    "cancels registration reminders when the current Telegram recipient is %s",
    async (state) => {
      await query("UPDATE users SET status='pending' WHERE id=$1", [userId]);
      await recordActivity({
        telegramId: telegram,
        userId: null,
        registered: false,
        canMessage: true,
      });
      await enable("REG_01");
      await scheduleNotifications();
      const [run] = await query<{ id: string }>(
        "SELECT id FROM notification_runs WHERE identity_key=$1 AND trigger_id='REG_01'",
        ["tg:" + telegram],
      );
      expect(run).toBeDefined();
      if (state === "blocked")
        await query("UPDATE users SET status='blocked' WHERE id=$1", [userId]);
      else if (state === "unreachable")
        await query("UPDATE users SET telegram_reachable=false WHERE id=$1", [
          userId,
        ]);
      else
        await query(
          "INSERT INTO notification_profiles(user_id,enabled) VALUES($1,false)",
          [userId],
        );
      const send = vi.fn(async () => undefined);
      expect(await sendNotification(run.id, send)).toBe("cancelled");
      expect(send).not.toHaveBeenCalled();
    },
  );
  it("preserves a draft, rejects another user, and refuses to reopen a submitted request key", async () => {
    const [car] = await query<{ id: string }>(
      "INSERT INTO club_content(kind,title,daily_price_kopecks,active) VALUES('car','Notification QA',100000,true) RETURNING id",
    );
    const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      key = randomUUID();
    const input = {
      carId: car.id,
      startDate: day,
      endDate: day,
      comment: "Saved selection",
      requestKey: key,
    };
    const created = await api("me/booking-draft", input);
    expect(created.status).toBe(200);
    const d = await created.json();
    expect((await api("me/booking-draft?id=" + d.id)).status).toBe(200);
    await enable("BOOK_01");
    await scheduleNotifications();
    const [r] = await runs("BOOK_01");
    expect(r).toBeTruthy();
    const quote = await (await api("me/rental-quotes", input)).json();
    expect(
      (
        await api("me/rental-requests", {
          ...input,
          expectedCarVersion: quote.carVersion,
          expectedProgramId: quote.programId,
          expectedTotal: quote.totalKopecks,
        })
      ).status,
    ).toBe(201);
    expect(await (await api("me/booking-draft", input)).json()).toEqual({
      completed: true,
    });
    expect((await api("me/booking-draft?id=" + d.id)).status).toBe(404);
    const send = vi
      .fn<
        (
          target: string,
          text: string,
          url: string,
          cta: string,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    expect(await sendNotification(r.id, send)).toBe("cancelled");
    const stranger = randomToken();
    const strangerTelegram = String(BigInt(telegram) + 1n);
    const [other] = await query<{ id: string }>(
      "INSERT INTO users(name,status,telegram_id) VALUES('Other draft owner','active',$1) RETURNING id",
      [strangerTelegram],
    );
    users.push(other.id);
    await query(
      "INSERT INTO miniapp_sessions(token_hash,user_id,telegram_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
      [hashToken(stranger), other.id, strangerTelegram],
    );
    expect(
      (
        await api(
          "me/booking-draft?id=" + d.id,
          undefined,
          "rpm_session=" + stranger,
        )
      ).status,
    ).toBe(404);
  });
  it("cancels a booking reminder if its vehicle was withdrawn after scheduling", async () => {
    const [car] = await query<{ id: string }>(
      "INSERT INTO club_content(kind,title,daily_price_kopecks,active) VALUES('car','Withdrawn reminder QA',100000,true) RETURNING id",
    );
    const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const response = await api("me/booking-draft", {
      carId: car.id,
      requestKey: randomUUID(),
      startDate: day,
      endDate: day,
    });
    expect(response.status).toBe(200);
    await enable("BOOK_01");
    await scheduleNotifications();
    const [run] = await runs("BOOK_01");
    expect(run).toBeDefined();
    await query("UPDATE club_content SET active=false WHERE id=$1", [car.id]);
    const send = vi.fn(async () => undefined);
    expect(await sendNotification(run.id, send)).toBe("cancelled");
    expect(send).not.toHaveBeenCalled();
  });
  it("does not revive outdated rule settings when recovering a crashed sending lease", async () => {
    await enable("RIDE_01");
    await ride();
    await scheduleNotifications();
    const [run] = await runs("RIDE_01");
    await query(
      "UPDATE notification_runs SET status='sending',attempts=1,lease_until=now()-interval '1 minute' WHERE id=$1",
      [run.id],
    );
    await query(
      "UPDATE notification_rules SET config=jsonb_set(config,'{body}',to_jsonb('Updated approved text'::text)),version=version+1 WHERE id='RIDE_01'",
    );
    const send = vi.fn(async () => undefined);
    expect(await sendNotification(run.id, send)).toBe("cancelled");
    expect(send).not.toHaveBeenCalled();
    expect((await runs("RIDE_01"))[0].reason).toBe("RULE_UPDATED");
  });
  it("persists claims before sending, retries expired leases, honors provider delay and stops blocked channels", async () => {
    await enable("RIDE_01");
    await ride();
    await scheduleNotifications();
    const [r] = await runs("RIDE_01");
    const fail = vi.fn(async () => {
      const [claim] = await query<{ status: string; attempts: number }>(
        "SELECT status,attempts FROM notification_runs WHERE id=$1",
        [r.id],
      );
      expect(claim).toMatchObject({ status: "sending", attempts: 1 });
      throw new ProviderError("telegram", 429, 300);
    });
    expect(await sendNotification(r.id, fail)).toBe("retry");
    const [delay] = await query<{ seconds: number }>(
      "SELECT extract(epoch FROM scheduled_at-now())::int seconds FROM notification_runs WHERE id=$1",
      [r.id],
    );
    expect(delay.seconds).toBeGreaterThan(295);
    await query(
      "UPDATE notification_runs SET status='sending',scheduled_at=now(),lease_until=now()-interval '1 minute' WHERE id=$1",
      [r.id],
    );
    const blocked = vi.fn(async () => {
      throw new ProviderError("telegram", 403);
    });
    expect(await sendNotification(r.id, blocked)).toBe("failed");
    expect(await sendNotification(r.id, blocked)).toBe("failed");
    expect(blocked).toHaveBeenCalledTimes(1);
    const [u] = await query<{ telegram_reachable: boolean }>(
      "SELECT telegram_reachable FROM users WHERE id=$1",
      [userId],
    );
    expect(u.telegram_reachable).toBe(false);
  });
  it("shares the daily slot with legacy messages and keeps retries idempotent", async () => {
    expect(
      await reserveNotificationSlot(telegram, "service", "outbox:qa"),
    ).toBe(true);
    expect(
      await reserveNotificationSlot(telegram, "service", "outbox:qa"),
    ).toBe(true);
    await enable("RIDE_01");
    await ride();
    await scheduleNotifications();
    const [r] = await runs("RIDE_01");
    const send = vi.fn(async () => undefined);
    expect(await sendNotification(r.id, send)).toBe("deferred");
    expect(send).not.toHaveBeenCalled();
    expect(
      await reserveNotificationSlot(telegram, "marketing", "promo:qa"),
    ).toBe(true);
    expect(
      await reserveNotificationSlot(telegram, "transactional", "finance:qa"),
    ).toBe(true);
    await query(
      "UPDATE program_settings SET value=jsonb_set(value,'{day}','\"2000-01-01\"') WHERE key=$1",
      ["notifications:daily:tg:" + telegram + ":service"],
    );
    expect(await reserveNotificationSlot(telegram, "service", "new-day")).toBe(
      true,
    );
  });
  it("requires birthday consent, allows revocation, and rejects non-admin settings", async () => {
    expect(
      (
        await api("me/notification-preferences", {
          enabled: true,
          birthday: "2000-01-01",
          birthdayConsent: false,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await api("me/notification-preferences", {
          enabled: true,
          birthday: "2000-01-01",
          birthdayConsent: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api("me/notification-preferences", {
          enabled: false,
          birthday: null,
          birthdayConsent: false,
        })
      ).status,
    ).toBe(200);
    const p = await (await api("me/notification-preferences")).json();
    expect(p.birthday).toBeNull();
    expect(p.enabled).toBe(false);
    expect((await api("admin/notifications")).status).toBe(401);
    const tables = await query<{ tablename: string; rowsecurity: boolean }>(
      "SELECT tablename,rowsecurity FROM pg_tables WHERE tablename LIKE 'notification_%' OR tablename='booking_drafts'",
    );
    expect(tables).toHaveLength(5);
    expect(tables.every((t) => t.rowsecurity)).toBe(true);
  });
  it("creates inactivity, return, anniversary, birthday and seven-day expiry from actual stored facts", async () => {
    const r = await ride();
    await transaction(async (tx) => {
      await tx.query("ALTER TABLE rentals DISABLE TRIGGER rental_completion");
      await tx.query(
        "UPDATE rentals SET completed_at=now()-interval '2 years' WHERE id=$1",
        [r.rentalId],
      );
      await tx.query("ALTER TABLE rentals ENABLE TRIGGER rental_completion");
    });
    await query(
      "INSERT INTO notification_profiles(user_id,birthday,birthday_consent_at) VALUES($1,((now() AT TIME ZONE 'Europe/Moscow')::date-interval '25 years')::date,now())",
      [userId],
    );
    await recordActivity({
      telegramId: telegram,
      userId,
      registered: true,
      canMessage: true,
    });
    await query(
      "UPDATE notification_activity SET previous_open_at=now()-interval '30 days',return_open_at=now()-interval '2 hours' WHERE user_id=$1",
      [userId],
    );
    const credit = await creditBonus(
      {
        userId,
        amount: "100",
        reason: "QA expiry",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    await query(
      "UPDATE bonus_lots SET expires_at=now()+interval '6 days' WHERE credit_transaction_id=$1",
      [credit.transactionId],
    );
    const ids = ["RET_01", "APP_01", "BDAY_01", "ANNIV_01", "EXP_01"] as const;
    for (const id of ids) await enable(id, { morningHour: 0 });
    await scheduleNotifications();
    for (const id of ids) expect((await runs(id)).length, id).toBe(1);
    await scheduleNotifications();
    for (const id of ids) expect((await runs(id)).length, id).toBe(1);
    await query(
      "UPDATE notification_profiles SET birthday=NULL,birthday_consent_at=NULL WHERE user_id=$1",
      [userId],
    );
    const send = vi
      .fn<
        (
          target: string,
          text: string,
          url: string,
          cta: string,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    expect(await sendNotification((await runs("BDAY_01"))[0].id, send)).toBe(
      "cancelled",
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("creates unused-bonus/progress/level events and cancels stale progress at the maximum level", async () => {
    await ride();
    await processRental(
      {
        userId,
        externalRentalId: randomUUID(),
        carName: "Notification QA",
        startDate: "2026-09-01",
        endDate: "2026-09-02",
        status: "completed",
        paymentStatus: "paid",
        amountKopecks: "40000000",
        idempotencyKey: randomUUID(),
        mode: "operational",
      },
      actor,
    );
    await creditBonus(
      { userId, amount: "50", reason: "QA", idempotencyKey: randomUUID() },
      actor,
    );
    await enable("LOY_01");
    await enable("LVL_01", { nearAmountKopecks: "999999999999" });
    await enable("LVL_02");
    await scheduleNotifications();
    for (const id of ["LOY_01", "LVL_01", "LVL_02"] as const)
      expect((await runs(id)).length, id).toBeGreaterThan(0);
    await query(
      "UPDATE loyalty_accounts SET manual_override='SIGNATURE' WHERE user_id=$1",
      [userId],
    );
    const send = vi
      .fn<
        (
          target: string,
          text: string,
          url: string,
          cta: string,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    expect(await sendNotification((await runs("LVL_01"))[0].id, send)).toBe(
      "cancelled",
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("applies cooldown and records only owned, sent, target-screen opens", async () => {
    await enable("PROMO_01", { category: "transactional", cooldownHours: 168 });
    await creditBonus(
      { userId, amount: "40", reason: "QA", idempotencyKey: randomUUID() },
      actor,
    );
    await scheduleNotifications();
    const send = vi
      .fn<
        (
          target: string,
          text: string,
          url: string,
          cta: string,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    const first = (await runs("PROMO_01"))[0];
    expect(await sendNotification(first.id, send)).toBe("sent");
    expect(
      (
        await api("me/notification-activity", {
          notification: first.id,
          path: "/profile",
        })
      ).status,
    ).toBe(200);
    const [opened] = await query<{ opened_at: string; converted_at: string }>(
      "SELECT opened_at,converted_at FROM notification_runs WHERE id=$1",
      [first.id],
    );
    expect(opened.opened_at).toBeTruthy();
    expect(opened.converted_at).toBeTruthy();
    await creditBonus(
      { userId, amount: "45", reason: "QA", idempotencyKey: randomUUID() },
      actor,
    );
    await scheduleNotifications();
    const second = (await runs("PROMO_01"))[1];
    expect(await sendNotification(second.id, send)).toBe("cancelled");
    expect((await runs("PROMO_01"))[1].reason).toBe("COOLDOWN");
  });
});
