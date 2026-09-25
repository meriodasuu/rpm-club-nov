import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { closePool, query, transaction } from "../src/lib/db";
import { clubRoute } from "../src/lib/api/club";
import { handle } from "../src/lib/http";
import { hashToken, randomToken } from "../src/lib/auth/session";
import {
  getProgram,
  publishProgram,
  processRental,
  getAccountSnapshot,
  getAccountSnapshotInTransaction,
  recalculateTiers,
  type Program,
} from "../src/lib/loyalty";
import {
  scheduleClubTriggers,
  clubTriggerMessage,
} from "../src/lib/club/triggers";
import type { OutboxEvent } from "../src/lib/jobs/telegram";
import { moscowDate } from "../src/lib/club/contracts";
const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const base = "http://127.0.0.1:3001",
  actor = { id: "club-tests", role: "admin" as const };
let original: Program,
  admin: string,
  viewer: string,
  user: { id: string; cookie: string },
  other: { id: string; cookie: string };
async function member() {
  const token = randomToken(),
    telegram = String(
      BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 11)),
    );
  const [u] = await query<{ id: string }>(
    "INSERT INTO users(name,status,telegram_id,marketing_consent) VALUES('Club synthetic','active',$1,true) RETURNING id",
    [telegram],
  );
  await query(
    "INSERT INTO loyalty_accounts(user_id,member_since) VALUES($1,now()-interval '1 day') ON CONFLICT(user_id) DO UPDATE SET member_since=excluded.member_since",
    [u.id],
  );
  await query(
    "INSERT INTO miniapp_sessions(user_id,telegram_id,token_hash,expires_at,telegram_profile) VALUES($1,$2,$3,now()+interval '1 hour','{}')",
    [u.id, telegram, hashToken(token)],
  );
  return { id: u.id, cookie: "rpm_session=" + token };
}
async function staff(role: string) {
  const token = randomToken();
  const [m] = await query<{ id: string }>(
    "INSERT INTO admin_memberships(auth_user_id,name,email,role) VALUES($1,'Club QA',$2,$3) RETURNING id",
    [randomUUID(), randomUUID() + "@example.invalid", role],
  );
  await query(
    "INSERT INTO staff_sessions(token_hash,membership_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [hashToken(token), m.id],
  );
  return "rpm_staff=" + token;
}
function call(
  path: string,
  cookie = "",
  data?: unknown,
  options: { method?: string; key?: string; origin?: string } = {},
) {
  const request = new Request(base + "/api/" + path, {
    method: options.method ?? (data === undefined ? "GET" : "POST"),
    headers: {
      cookie,
      origin: options.origin ?? base,
      "content-type": "application/json",
      "idempotency-key": options.key ?? randomUUID(),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return handle(
    async () =>
      (await clubRoute(request, path.split("?")[0])) ??
      new Response(null, { status: 404 }),
  );
}
async function car() {
  return (
    await query<{ id: string; version: number }>(
      "INSERT INTO club_content(kind,title,daily_price_kopecks,active) VALUES('car','QA Car',1000099,true) RETURNING id,version",
    )
  )[0];
}
async function request(
  carId: string,
  member = user,
  start = moscowDate(new Date(Date.now() + 2 * 86400000)),
) {
  const data = { carId, startDate: start, endDate: start };
  const q = await (await call("me/rental-quotes", member.cookie, data)).json();
  const input = {
    ...data,
    expectedTotal: q.totalKopecks,
    expectedCarVersion: q.carVersion,
    expectedProgramId: q.programId,
  };
  const key = randomUUID(),
    response = await call("me/rental-requests", member.cookie, input, { key });
  expect(response.status).toBe(201);
  return { row: await response.json(), input, key };
}
suite("club content, booking and trigger integration", () => {
  const previousUrl = process.env.APP_URL;
  beforeAll(async () => {
    process.env.APP_URL = base;
    original = await getProgram();
    admin = await staff("admin");
    viewer = await staff("viewer");
    user = await member();
    other = await member();
  });
  afterAll(async () => {
    process.env.APP_URL = previousUrl;
    if (original)
      await publishProgram(
        {
          ...original,
          reason: "restore club test program",
          idempotencyKey: randomUUID(),
        },
        actor,
      );
    await query("UPDATE trigger_rules SET enabled=false");
    await closePool();
  });
  it("enforces roles, origin, publication and request ownership", async () => {
    expect(
      (
        await call("admin/club-content", admin, {
          kind: "car",
          title: "Forbidden duplicate",
          dailyPriceKopecks: "100000",
          active: true,
        })
      ).status,
    ).toBe(409);
    expect((await call("admin/club-content?kind=car")).status).toBe(401);
    expect(
      (await call("admin/club-content", viewer, { kind: "car" })).status,
    ).toBe(403);
    expect((await call("admin/trigger-rules", viewer)).status).toBe(403);
    expect(
      (
        await call(
          "me/rental-quotes",
          user.cookie,
          {},
          { origin: "https://foreign.invalid" },
        )
      ).status,
    ).toBe(403);
    const draft = await (
      await call("admin/club-content", admin, {
        kind: "wiki",
        title: "Hidden QA",
        body: "Hidden",
      })
    ).json();
    expect(
      (
        await (await call("club/content?kind=wiki", user.cookie)).json()
      ).items.some((i: { id: string }) => i.id === draft.id),
    ).toBe(false);
    expect(
      (
        await call(
          "admin/club-content/" + draft.id,
          admin,
          {
            kind: "wiki",
            title: "Updated",
            body: "Answer",
            active: true,
            expectedVersion: draft.version,
          },
          { method: "PATCH" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          "admin/club-content/" + draft.id,
          admin,
          {
            kind: "wiki",
            title: "Old version",
            expectedVersion: draft.version,
          },
          { method: "PATCH" },
        )
      ).status,
    ).toBe(409);
    const c = await car(),
      r = await request(c.id);
    expect(
      (
        await call(
          "me/rental-requests/" + r.row.id + "/cancel",
          other.cookie,
          {},
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await (await call("me/rental-requests", other.cookie)).json()
      ).items.some((i: { id: string }) => i.id === r.row.id),
    ).toBe(false);
    expect(
      (
        await call(
          "me/rental-requests/" + r.row.id + "/cancel",
          user.cookie,
          {},
        )
      ).status,
    ).toBe(200);
  });
  it("returns the current daily price when a catalog price changes", async () => {
    const c = await car();
    await query(
      "UPDATE club_content SET daily_price_kopecks=2000099,version=version+1 WHERE id=$1",
      [c.id],
    );
    const start = moscowDate();
    const response = await call("me/rental-quotes", user.cookie, {
      carId: c.id,
      startDate: start,
      endDate: start,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dailyPriceKopecks: "2000099",
      grossKopecks: "2000099",
      carVersion: c.version + 1,
    });
  });
  it("replays an existing request after its start date without creating another rental request", async () => {
    const c = await car(),
      r = await request(c.id, other, moscowDate());
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * 86400000);
      const repeated = await call("me/rental-requests", other.cookie, r.input, {
        key: r.key,
      });
      expect(repeated.status).toBe(201);
      expect((await repeated.json()).id).toBe(r.row.id);
      const changed = await call(
        "me/rental-requests",
        other.cookie,
        { ...r.input, comment: "Changed" },
        { key: r.key },
      );
      expect(changed.status).toBe(409);
      const newRequest = await call(
        "me/rental-requests",
        other.cookie,
        r.input,
      );
      expect(newRequest.status).toBe(422);
    } finally {
      vi.useRealTimers();
    }
  });
  it("fixes an exact discount quote and confirms once under concurrency", async () => {
    await publishProgram(
      {
        ...original,
        rewardMode: "discount",
        tiers: original.tiers.map((t) => ({ ...t, rateBps: 750 })),
        reason: "discount test",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    const c = await car(),
      r = await request(c.id);
    expect(r.row.discount_kopecks).toBe("75007");
    expect(r.row.total_kopecks).toBe("925092");
    const repeat = await call("me/rental-requests", user.cookie, r.input, {
      key: r.key,
    });
    expect((await repeat.json()).id).toBe(r.row.id);
    expect(
      (
        await call(
          "me/rental-requests",
          user.cookie,
          { ...r.input, comment: "different" },
          { key: r.key },
        )
      ).status,
    ).toBe(409);
    const responses = await Promise.all(
      [1, 2].map(() =>
        call("admin/rental-requests/" + r.row.id, admin, {
          status: "accepted",
          pickupTime: "12:00",
          note: "Confirmed QA",
        }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const [count] = await query<{ n: number }>(
      "SELECT count(*)::int n FROM rentals WHERE external_rental_id=$1",
      ["app:" + r.row.id],
    );
    expect(count.n).toBe(1);
    const second = await request(c.id, other);
    expect(
      (
        await call("admin/rental-requests/" + second.row.id, admin, {
          status: "accepted",
          pickupTime: "12:00",
          note: "overlap test",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          "me/rental-requests/" + r.row.id + "/cancel",
          user.cookie,
          {},
        )
      ).status,
    ).toBe(409);
    await call(
      "me/rental-requests/" + second.row.id + "/cancel",
      other.cookie,
      {},
    );
    const old = r.input;
    await query(
      "UPDATE club_content SET daily_price_kopecks=daily_price_kopecks+100,version=version+1 WHERE id=$1",
      [c.id],
    );
    expect((await call("me/rental-requests", user.cookie, old)).status).toBe(
      409,
    );
  });
  it("discount rentals progress the tier without earning cashback", async () => {
    const u = await member(),
      today = moscowDate();
    const r = await processRental(
      {
        userId: u.id,
        externalRentalId: randomUUID(),
        carName: "Discount QA",
        startDate: today,
        endDate: today,
        amountKopecks: "15000000",
        status: "completed",
        paymentStatus: "paid",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    expect(r.bonus).toBe("0");
    expect(r.snapshot.cashback_rate_bps).toBe(0);
    expect(r.snapshot.discount_rate_bps).toBe(750);
    expect(r.snapshot.tier).toBe("DRIVE");
    expect((await getAccountSnapshot(u.id)).total_rental_amount).toBe(
      "15000000",
    );
  });
  it("reads the sixth tier from a persisted program without altering legacy history", async () => {
    await expect(
      transaction(async (tx) => {
        const p = await getProgram(),
          tiers = [
            ...p.tiers.slice(0, 3),
            {
              code: "PLATINUM",
              thresholdKopecks: "50000000",
              rateBps: 900,
              benefits: ["Мойка"],
            },
            ...p.tiers.slice(3),
          ];
        await tx.query(
          "INSERT INTO program_versions(version,tiers,reward_mode,redemption_limit_bps,expiry_days,referrer_reward,referred_reward,program_starts_at,published_by) SELECT version+1,$1,'discount',redemption_limit_bps,expiry_days,referrer_reward,referred_reward,program_starts_at,'qa' FROM program_versions ORDER BY version DESC LIMIT 1",
          [JSON.stringify(tiers)],
        );
        await tx.query(
          "UPDATE loyalty_accounts SET total_rental_amount=60000000,calculated_tier='PLATINUM',achieved_tier='PLATINUM' WHERE user_id=$1",
          [user.id],
        );
        const snapshot = await getAccountSnapshotInTransaction(tx, user.id);
        expect(snapshot.next_tier).toBe("RED");
        expect(snapshot.discount_rate_bps).toBe(900);
        expect(snapshot.benefits).toContain("Мойка");
        throw new Error("ROLLBACK_QA");
      }),
    ).rejects.toThrow("ROLLBACK_QA");
  });
  it("schedules once, checks consent again, and suppresses withdrawn routes", async () => {
    expect(
      (
        await call("admin/club-content", admin, {
          kind: "route",
          title: "QA route",
          body: "Route description",
          active: true,
        })
      ).status,
    ).toBe(409);
    const [route] = await query<{ id: string }>(
      "INSERT INTO club_content(kind,title,body,active,published_at,source,source_id) VALUES('route','QA route','Route description',true,now(),'rpm-rent-locations',$1) RETURNING id",
      [randomUUID()],
    );
    expect(
      (
        await call(
          "admin/club-content/" + route.id,
          admin,
          {
            kind: "route",
            title: "Changed route",
            body: "Changed description",
            active: false,
            expectedVersion: 1,
          },
          { method: "PATCH" },
        )
      ).status,
    ).toBe(409);
    await query("UPDATE trigger_rules SET enabled=true WHERE kind='new_route'");
    await scheduleClubTriggers(500);
    await scheduleClubTriggers(500);
    const events = await query<OutboxEvent>(
      "SELECT * FROM outbox_events WHERE event_type='CLUB_TRIGGER' AND aggregate_id=$1 AND user_id=$2",
      [route.id, user.id],
    );
    expect(events).toHaveLength(1);
    expect(await clubTriggerMessage(events[0], false, "MEMBER")).toBeNull();
    expect(await clubTriggerMessage(events[0], true, "MEMBER")).toContain(
      "QA route",
    );
    await query("UPDATE club_content SET active=false WHERE id=$1", [route.id]);
    expect(await clubTriggerMessage(events[0], true, "MEMBER")).toBeNull();
    await query(
      "UPDATE trigger_rules SET enabled=false WHERE kind='new_route'",
    );
  });
  it("generates rental and offer triggers without duplicate events", async () => {
    const u = await member(),
      tomorrow = moscowDate(new Date(Date.now() + 86400000));
    const accepted = await processRental(
      {
        userId: u.id,
        externalRentalId: randomUUID(),
        carName: "Trip QA",
        startDate: tomorrow,
        pickupAt: tomorrow + "T12:00:00+03:00",
        endDate: tomorrow,
        amountKopecks: "100000",
        status: "accepted",
        paymentStatus: "unpaid",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    const yesterday = moscowDate(new Date(Date.now() - 86400000));
    const completed = await processRental(
      {
        userId: u.id,
        externalRentalId: randomUUID(),
        carName: "Finished QA",
        startDate: yesterday,
        endDate: yesterday,
        amountKopecks: "100000",
        status: "completed",
        paymentStatus: "paid",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    await query(
      "UPDATE rentals SET processed_at=now()-interval '2 hours' WHERE id=$1",
      [completed.rentalId],
    );
    const [offer] = await query<{ id: string }>(
      "INSERT INTO offers(title,description,minimum_tier,start_at,end_at,cta_url,active,created_by) VALUES('QA offer','Details','MEMBER',now()-interval '1 hour',now()+interval '1 hour','https://example.invalid',true,'qa') RETURNING id",
    );
    await query(
      "UPDATE trigger_rules SET enabled=true,lead_hours=CASE WHEN kind IN ('after_rental','offer_reminder') THEN 0 ELSE 72 END WHERE kind IN ('before_rental','after_rental','weather','offer_reminder')",
    );
    await scheduleClubTriggers(500);
    await scheduleClubTriggers(500);
    const events = await query<OutboxEvent>(
      "SELECT * FROM outbox_events WHERE event_type='CLUB_TRIGGER' AND user_id=$1 AND aggregate_id=ANY($2::text[])",
      [u.id, [accepted.rentalId, completed.rentalId, offer.id]],
    );
    expect(events.map((e) => e.payload.kind).sort()).toEqual([
      "after_rental",
      "before_rental",
      "offer_reminder",
      "weather",
    ]);
    const before = events.find((e) => e.payload.kind === "before_rental")!;
    expect(await clubTriggerMessage(before, false, "MEMBER")).toContain(
      "Trip QA",
    );
    await query("UPDATE rentals SET status='cancelled' WHERE id=$1", [
      accepted.rentalId,
    ]);
    expect(await clubTriggerMessage(before, true, "MEMBER")).toBeNull();
    await query("UPDATE offers SET active=false WHERE id=$1", [offer.id]);
    expect(
      await clubTriggerMessage(
        events.find((e) => e.payload.kind === "offer_reminder")!,
        true,
        "MEMBER",
      ),
    ).toBeNull();
  });
  it("loads weather from the provider, caches it and rejects an invalid forecast", async () => {
    const u = await member(),
      tomorrow = moscowDate(new Date(Date.now() + 86400000));
    const r = await processRental(
      {
        userId: u.id,
        externalRentalId: randomUUID(),
        carName: "Weather QA",
        startDate: tomorrow,
        pickupAt: tomorrow + "T12:00:00+03:00",
        endDate: tomorrow,
        amountKopecks: "100000",
        status: "accepted",
        paymentStatus: "unpaid",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    const city = "QA " + randomUUID();
    await query(
      "UPDATE trigger_rules SET enabled=true,city=$1,latitude=59.9,longitude=30.3,lead_hours=72 WHERE kind='weather'",
      [city],
    );
    const event: OutboxEvent = {
      id: randomUUID(),
      event_key: randomUUID(),
      event_type: "CLUB_TRIGGER",
      user_id: u.id,
      aggregate_id: r.rentalId,
      account_version: "0",
      created_at: new Date().toISOString(),
      payload: {
        kind: "weather",
        resource_id: r.rentalId,
        occurrence_at: tomorrow + "T12:00:00+03:00",
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      },
    };
    vi.stubEnv("OPEN_METEO_API_KEY", "test-only-weather-key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          daily: {
            time: [tomorrow],
            temperature_2m_min: [10],
            temperature_2m_max: [17],
            precipitation_probability_max: [80],
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await clubTriggerMessage(event, false, "MEMBER")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await clubTriggerMessage(event, true, "MEMBER")).toContain(
        "10…17 °C",
      );
      expect(await clubTriggerMessage(event, true, "MEMBER")).toContain("80%");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await query("UPDATE trigger_rules SET city=$1 WHERE kind='weather'", [
        city + "-invalid",
      ]);
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ daily: { time: ["2000-01-01"] } })),
      );
      await expect(
        clubTriggerMessage(event, true, "MEMBER"),
      ).rejects.toMatchObject({ provider: "weather", status: 503 });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it("protects new tables with RLS and no public grants", async () => {
    const rows = await query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname,relrowsecurity FROM pg_class WHERE oid=ANY(ARRAY['club_content'::regclass,'rental_requests'::regclass,'trigger_rules'::regclass])",
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    const [grants] = await query<{ n: number }>(
      "SELECT count(*)::int n FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name IN ('club_content','rental_requests','trigger_rules') AND grantee IN ('PUBLIC','anon','authenticated')",
    );
    expect(grants.n).toBe(0);
  });
  it("does not enqueue an unchanged account during program recalculation", async () => {
    const u = await member(),
      raw = (BigInt("0x" + u.id.replaceAll("-", "")) - 1n)
        .toString(16)
        .padStart(32, "0");
    const cursor = raw.replace(
      /^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/,
      "$1-$2-$3-$4-$5",
    );
    const p = await getProgram(),
      before = await getAccountSnapshot(u.id);
    await recalculateTiers({ limit: 1, cursor, programVersionId: p.id });
    const first = await getAccountSnapshot(u.id);
    expect(BigInt(first.account_version)).toBe(BigInt(before.account_version));
    await recalculateTiers({ limit: 1, cursor, programVersionId: p.id });
    expect((await getAccountSnapshot(u.id)).account_version).toBe(
      first.account_version,
    );
    expect(
      (
        await query("SELECT id FROM outbox_events WHERE event_key=$1", [
          `program-display:${p.id}:${u.id}`,
        ])
      ).length,
    ).toBe(0);
  });
});
