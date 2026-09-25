import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { query, closePool } from "../src/lib/db";
import { authRoute } from "../src/lib/auth/routes";
import { adminRoute } from "../src/lib/api/admin";
import { clientRoute } from "../src/lib/api/client";
import { operationsRoute } from "../src/lib/api/operations";
import { requireStaff, hashToken, randomToken } from "../src/lib/auth/session";
import { handle } from "../src/lib/http";
import {
  previewImport,
  commitImport,
  resolveCustomer,
} from "../src/lib/imports/service";
import { normalizeRentalRow } from "../src/lib/imports/parser";
import { getAccountSnapshot } from "../src/lib/loyalty";
import { telegramMessage } from "../src/lib/jobs/telegram";
const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const base = "http://127.0.0.1:3001",
  actor = { id: "app-test", role: "admin" as const };
let phoneCounter = 0;
const phone = () =>
  "+78" +
  (Date.now() % 1e8).toString().padStart(8, "0") +
  (++phoneCounter % 10);
const tg = () =>
  String(BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 11)));
async function member(status = "active", telegram = tg()) {
  return (
    await query<{ id: string; telegram_id: string; referral_code: string }>(
      `INSERT INTO users(name,status,telegram_id) VALUES('App synthetic user',$1,$2) RETURNING id,telegram_id,referral_code`,
      [status, telegram],
    )
  )[0];
}
async function session(userId: string | null, telegram: string) {
  const token = randomToken();
  const [row] = await query<{ id: string }>(
    `INSERT INTO miniapp_sessions(user_id,telegram_id,telegram_profile,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour') RETURNING id`,
    [
      userId,
      telegram,
      JSON.stringify({ id: Number(telegram), first_name: "Test" }),
      hashToken(token),
    ],
  );
  return { id: row.id, cookie: "rpm_session=" + token };
}
async function staff(role = "admin") {
  const token = randomToken(),
    authId = randomUUID();
  const [m] = await query<{ id: string }>(
    `INSERT INTO admin_memberships(auth_user_id,name,email,role) VALUES($1,'Test staff',$2,$3) RETURNING id`,
    [authId, authId + "@example.invalid", role],
  );
  await query(
    `INSERT INTO staff_sessions(token_hash,membership_id,expires_at) VALUES($1,$2,now()+interval '1 hour')`,
    [hashToken(token), m.id],
  );
  return { id: m.id, authId, cookie: "rpm_staff=" + token };
}
function req(
  path: string,
  cookie = "",
  data?: unknown,
  method = data === undefined ? "GET" : "POST",
  origin = base,
) {
  return new Request(base + "/api/" + path, {
    method,
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
async function call(
  path: string,
  cookie = "",
  data?: unknown,
  method?: string,
) {
  const request = req(path, cookie, data, method);
  const key = path.split("?")[0];
  return handle(
    async () =>
      (await authRoute(request, key)) ??
      (await clientRoute(request, key)) ??
      (await operationsRoute(request, key)) ??
      (await adminRoute(request, key)) ??
      new Response(null, { status: 404 }),
  );
}
const csv = (rows: Record<string, unknown>[]) =>
  Buffer.from(
    [
      "external_id;customer_name;phone;crm_customer_id;car_name;start_date;end_date;rental_amount;status;payment_status;qualified_at",
      ...rows.map((r) =>
        [
          "external_id",
          "customer_name",
          "phone",
          "crm_customer_id",
          "car_name",
          "start_date",
          "end_date",
          "rental_amount",
          "status",
          "payment_status",
          "qualified_at",
        ]
          .map((k) => String(r[k] ?? ""))
          .join(";"),
      ),
    ].join("\n"),
  );
function rental(extra: Record<string, unknown> = {}) {
  return {
    external_id: randomUUID(),
    customer_name: "Import synthetic",
    phone: phone(),
    car_name: "Test car",
    start_date: "2026-09-01",
    end_date: "2026-09-02",
    rental_amount: "10000",
    status: "completed",
    payment_status: "paid",
    ...extra,
  };
}
suite("HTTP identity, roles, imports and campaign boundaries", () => {
  it("staff status changes award Bonus once only after completion and payment", async () => {
    const s = await staff("manager"),
      u = await member();
    const created = await call("admin/rentals", s.cookie, {
      userId: u.id,
      externalRentalId: randomUUID(),
      carName: "Status flow car",
      startDate: "2026-09-01",
      endDate: "2026-09-02",
      amountKopecks: "3500000",
      status: "accepted",
      paymentStatus: "unpaid",
      reason: "Начало аренды",
    });
    expect(created.status).toBe(201);
    const rentalId = (await created.json()).rentalId;
    const change = async (status: string, paymentStatus: string) => {
      const [row] = await query("SELECT * FROM rentals WHERE id=$1", [
        rentalId,
      ]);
      return call(`admin/rentals/${rentalId}/status`, s.cookie, {
        status,
        paymentStatus,
        expectedVersion: row.version ?? 1,
        reason: "Обновление статуса аренды",
      });
    };
    expect((await change("in_progress", "unpaid")).status).toBe(200);
    expect((await change("completed", "unpaid")).status).toBe(200);
    expect((await getAccountSnapshot(u.id)).bonus_available).toBe("0");
    expect((await change("completed", "paid")).status).toBe(200);
    expect(await getAccountSnapshot(u.id)).toMatchObject({
      bonus_available: "700",
      total_rental_amount: "3500000",
    });
    expect((await change("completed", "paid")).status).toBe(200);
    expect((await getAccountSnapshot(u.id)).bonus_available).toBe("700");
    expect((await change("in_progress", "paid")).status).toBe(409);
    const viewer = await staff("viewer");
    expect(
      (
        await call(`admin/rentals/${rentalId}/status`, viewer.cookie, {
          status: "cancelled",
          paymentStatus: "paid",
          expectedVersion: 1,
          reason: "Forbidden",
        })
      ).status,
    ).toBe(403);
    expect((await change("cancelled", "paid")).status).toBe(200);
    expect((await getAccountSnapshot(u.id)).bonus_available).toBe("0");
  });
  it("concurrent completion and stale forms cannot double-credit a rental", async () => {
    const s = await staff(),
      u = await member();
    const created = await call("admin/rentals", s.cookie, {
      userId: u.id,
      externalRentalId: randomUUID(),
      carName: "Concurrent status car",
      startDate: "2026-09-01",
      endDate: "2026-09-02",
      amountKopecks: "3500000",
      status: "accepted",
      paymentStatus: "paid",
      reason: "Принята аренда",
    });
    expect(created.status).toBe(201);
    const rentalId = (await created.json()).rentalId;
    const [row] = await query("SELECT version FROM rentals WHERE id=$1", [
      rentalId,
    ]);
    const data = {
      status: "completed",
      paymentStatus: "paid",
      expectedVersion: row.version,
      reason: "Завершение аренды",
    };
    const results = await Promise.all([
      call(`admin/rentals/${rentalId}/status`, s.cookie, data),
      call(`admin/rentals/${rentalId}/status`, s.cookie, data),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await getAccountSnapshot(u.id)).bonus_available).toBe("700");
    const entries = await query(
      "SELECT id FROM bonus_transactions WHERE rental_id=$1 AND type='rental_cashback'",
      [rentalId],
    );
    expect(entries).toHaveLength(1);
    const history = await query(
      "SELECT before_data,after_data FROM audit_logs WHERE entity_id=$1 AND action='rental_status'",
      [rentalId],
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      before_data: { status: "accepted" },
      after_data: { status: "completed", bonus: "700" },
    });
  });
  beforeAll(() => {
    vi.stubEnv("APP_URL", base);
    vi.stubEnv(
      "TELEGRAM_WEBHOOK_SECRET",
      "synthetic-webhook-secret-32-characters",
    );
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await closePool();
  });
  it("requires origin and refuses viewer mutations", async () => {
    const s = await staff("viewer");
    expect(
      (
        await call("admin/bonus/credit", s.cookie, {
          userId: randomUUID(),
          amount: "10",
          reason: "test",
        })
      ).status,
    ).toBe(403);
    const response = await handle(
      async () =>
        (await authRoute(
          req("auth/logout", "", {}, "POST", "https://other.invalid"),
          "auth/logout",
        ))!,
    );
    expect(response.status).toBe(403);
  });
  it("returns own account and blocks access immediately", async () => {
    const u = await member(),
      s = await session(u.id, u.telegram_id),
      a = await staff();
    const response = await call("me", s.cookie);
    expect((await response.json()).user.id).toBe(u.id);
    const blocked = await call(`admin/customers/${u.id}/block`, a.cookie, {
      reason: "Synthetic block",
    });
    expect(blocked.status).toBe(200);
    expect((await call("me", s.cookie)).status).toBe(401);
  });
  it("promotion revokes the pre-MFA manager session", async () => {
    const manager = await staff("manager"),
      admin = await staff();
    await query(
      "UPDATE admin_memberships SET can_manage_staff=true WHERE id=$1",
      [admin.id],
    );
    const response = await call("admin/team", admin.cookie, {
      authUserId: manager.authId,
      name: "Promoted test",
      email: manager.authId + "@example.invalid",
      role: "admin",
      active: true,
      reason: "Promotion regression",
    });
    expect(response.status).toBe(200);
    await expect(
      requireStaff(req("admin/me", manager.cookie)),
    ).rejects.toMatchObject({ code: "STAFF_SESSION_EXPIRED" });
  });
  it("links both onboarding sessions when activation was completed concurrently", async () => {
    const u = await member(),
      s1 = await session(null, u.telegram_id),
      s2 = await session(null, u.telegram_id),
      data = { documentIds: [randomUUID(), randomUUID(), randomUUID()] };
    const responses = await Promise.all([
      call("me/activate", s1.cookie, data),
      call("me/activate", s2.cookie, data),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect((await call("me", s2.cookie)).status).toBe(200);
  });
  it("rejects another Telegram user contact and stale legal consent without activating", async () => {
    const u = await member("pending"),
      s = await session(u.id, u.telegram_id);
    await query(
      `INSERT INTO contact_requests(session_id,telegram_id,expires_at) VALUES($1,$2,now()+interval '5 minutes')`,
      [s.id, u.telegram_id],
    );
    const request = new Request(base + "/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": process.env.TELEGRAM_WEBHOOK_SECRET!,
      },
      body: JSON.stringify({
        update_id: Number(tg()),
        message: {
          from: { id: Number(u.telegram_id) },
          chat: { id: Number(u.telegram_id), type: "private" },
          contact: {
            user_id: Number(u.telegram_id) + 1,
            phone_number: phone(),
          },
        },
      }),
    });
    expect((await authRoute(request, "telegram/webhook"))!.status).toBe(200);
    expect(
      (
        await query("SELECT phone FROM contact_requests WHERE session_id=$1", [
          s.id,
        ])
      )[0].phone,
    ).toBeNull();
    await query(
      "UPDATE contact_requests SET phone=$2,consumed_at=now() WHERE session_id=$1",
      [s.id, phone()],
    );
    expect(
      (
        await call("me/activate", s.cookie, {
          documentIds: [randomUUID(), randomUUID(), randomUUID()],
        })
      ).status,
    ).toBe(409);
    expect(
      (await query("SELECT status FROM users WHERE id=$1", [u.id]))[0].status,
    ).toBe("pending");
  });
  it("serializes a CRM identity across conflicting phone requests", async () => {
    const crm = randomUUID(),
      one = normalizeRentalRow(rental({ crm_customer_id: crm })),
      two = normalizeRentalRow(rental({ crm_customer_id: crm }));
    const results = await Promise.allSettled([
      resolveCustomer(one, "rpm"),
      resolveCustomer(two, "rpm"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await query("SELECT id FROM users WHERE crm_customer_id=$1", [crm]),
    ).toHaveLength(1);
  });
  it("previews duplicate/conflict/nonqualifying rows without new customers or Bonus", async () => {
    const first = rental();
    const before = await previewImport(
      csv([first]),
      "synthetic.csv",
      "operational",
      { delimiter: ";" },
      actor,
    );
    await commitImport(String(before.batch.id), actor);
    const rows = [
      first,
      { ...first, external_id: randomUUID(), payment_status: "unpaid" },
      { ...first, rental_amount: "9000" },
    ];
    const [count] = await query<{ n: string }>("SELECT count(*) n FROM users");
    const preview = await previewImport(
      csv(rows),
      "synthetic.csv",
      "operational",
      { delimiter: ";" },
      actor,
    );
    expect(preview.rows.map((r) => r.status)).toEqual([
      "duplicate",
      "valid",
      "invalid",
    ]);
    expect(
      (preview.rows[1].result as { classification: string }).classification,
    ).toBe("nonqualifying");
    expect((await query("SELECT count(*) n FROM users"))[0].n).toBe(count.n);
  });
  it("orders timestamped and date-only rentals by the same timeline", async () => {
    const p = phone();
    const a = rental({
        phone: p,
        rental_amount: "95000",
        end_date: "2026-09-01",
      }),
      b = rental({
        phone: p,
        rental_amount: "10000",
        qualified_at: "2026-09-02T12:00:00Z",
      });
    const preview = await previewImport(
      csv([b, a]),
      "chronology.csv",
      "operational",
      { delimiter: ";" },
      actor,
    );
    const completed = await commitImport(String(preview.batch.id), actor);
    expect(completed.batch.status).toBe("completed");
    const [u] = await query<{ id: string }>(
      "SELECT id FROM users WHERE phone=$1",
      [p],
    );
    expect(await getAccountSnapshot(u.id)).toMatchObject({
      total_rental_amount: "10500000",
      tier: "DRIVE",
      bonus_available: "2200",
    });
  });
  it("explains unavailable campaigns before sending without creating a campaign", async () => {
    const a = await staff();
    for (const [active, start, end, reason] of [
      [false, -1, 1, "не опубликовано"],
      [true, 1, 2, "ещё не началось"],
      [true, -2, -1, "завершилось"],
    ] as const) {
      const [offer] = await query<{ id: string }>(
        `INSERT INTO offers(title,description,minimum_tier,start_at,end_at,cta_text,cta_url,active,created_by) VALUES('Campaign availability','Test','MEMBER',now()+$1*interval '1 day',now()+$2*interval '1 day','Open','https://rpmrent.ru',$3,'app-test') RETURNING id`,
        [start, end, active],
      );
      const path = `admin/offers/${offer.id}/campaigns`;
      const preview = await (await call(path, a.cookie)).json();
      expect(preview.available).toBe(false);
      expect(preview.blocked_reason).toContain(reason);
      const response = await call(path, a.cookie, { expectedVersion: 1 });
      expect(response.status).toBe(409);
      expect(JSON.stringify(await response.json())).toContain(reason);
      expect(
        await query("SELECT id FROM offer_campaigns WHERE offer_id=$1", [
          offer.id,
        ]),
      ).toHaveLength(0);
    }
  });
  it("refuses stale campaign versions and suppresses edited offers at delivery", async () => {
    const a = await staff(),
      u = await member();
    await query("UPDATE users SET marketing_consent=true WHERE id=$1", [u.id]);
    await query(
      "UPDATE loyalty_accounts SET member_since=now()-interval '1 day' WHERE user_id=$1",
      [u.id],
    );
    const [offer] = await query<{ id: string }>(
      `INSERT INTO offers(title,description,minimum_tier,start_at,end_at,cta_text,cta_url,active,created_by) VALUES('Original','Original copy','MEMBER',now()-interval '1 day',now()+interval '1 day','Open','https://rpmrent.ru',true,'app-test') RETURNING id`,
    );
    expect(
      (
        await call(`admin/offers/${offer.id}/campaigns`, a.cookie, {
          expectedVersion: 2,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(`admin/offers/${offer.id}/campaigns`, a.cookie, {
          expectedVersion: 1,
        })
      ).status,
    ).toBe(202);
    const [event] = await query<Parameters<typeof telegramMessage>[0]>(
      "SELECT * FROM outbox_events WHERE aggregate_id=$1 AND user_id=$2 AND event_type='RPM_DROP'",
      [offer.id, u.id],
    );
    expect(await telegramMessage(event, u.telegram_id)).toContain("Original");
    await query(
      "UPDATE offers SET version=version+1,title='Edited' WHERE id=$1",
      [offer.id],
    );
    expect(await telegramMessage(event, u.telegram_id)).toBeNull();
  });
  it("admin identity editing checks version, uniqueness and revokes sessions", async () => {
    const a = await staff(),
      u = await member(),
      other = await member(),
      s = await session(u.id, u.telegram_id),
      taken = phone();
    await query("UPDATE users SET phone=$2 WHERE id=$1", [other.id, taken]);
    const snapshot = await getAccountSnapshot(u.id);
    const data = {
      name: "Verified synthetic",
      phone: taken,
      telegramId: u.telegram_id,
      expectedVersion: snapshot.account_version,
      reason: "External identity check completed",
      identityVerified: true,
    };
    expect(
      (await call(`admin/customers/${u.id}/identity`, a.cookie, data)).status,
    ).toBe(409);
    data.phone = phone();
    expect(
      (await call(`admin/customers/${u.id}/identity`, a.cookie, data)).status,
    ).toBe(200);
    expect((await call("me", s.cookie)).status).toBe(401);
    expect(
      (await call(`admin/customers/${u.id}/identity`, a.cookie, data)).status,
    ).toBe(409);
    expect(
      (await query("SELECT name FROM users WHERE id=$1", [u.id]))[0].name,
    ).toBe(data.name);
  });
  it("previews thresholds without publishing and exposes own QR without private fields", async () => {
    const a = await staff(),
      u = await member(),
      s = await session(u.id, u.telegram_id);
    const response = await call("me/qr", s.cookie);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    const svg = await response.text();
    expect(svg).toContain("<svg");
    expect(svg).not.toContain(u.telegram_id);
    const current = await call("admin/settings", a.cookie),
      program = (await current.json()).program;
    const before = await query("SELECT count(*) n FROM program_versions");
    const preview = await call("admin/program-preview", a.cookie, {
      tiers: program.tiers,
    });
    expect(preview.status).toBe(200);
    expect((await preview.json()).upgrades).toBeTypeOf("number");
    expect((await query("SELECT count(*) n FROM program_versions"))[0].n).toBe(
      before[0].n,
    );
  });
  it("serves dashboard metrics and enforces server-side list filters", async () => {
    const a = await staff(),
      u = await member();
    const dashboard = await call("admin/dashboard", a.cookie);
    expect(dashboard.status).toBe(200);
    expect((await dashboard.json()).stats.net_bonus).toMatch(/^-?\d+$/);
    const rentals = await call(
      "admin/rentals?status=cancelled&payment_status=paid",
      a.cookie,
    );
    expect(rentals.status).toBe(200);
    for (const r of (await rentals.json()).items)
      expect(r).toMatchObject({ status: "cancelled", payment_status: "paid" });
    const bonus = await call(
      "admin/transactions?type=manual_credit&user_id=" + u.id,
      a.cookie,
    );
    expect(bonus.status).toBe(200);
    expect((await bonus.json()).items).toEqual([]);
    const detail = await call("admin/customers/" + u.id, a.cookie);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toHaveProperty("crmIdentities");
    expect(
      (
        await call(
          "admin/rentals?date_from=2026-09-10&date_to=2026-09-01",
          a.cookie,
        )
      ).status,
    ).toBe(422);
  });
});
