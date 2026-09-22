import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { query, closePool } from "../src/lib/db";
import { processRental, updateRentalStatus } from "../src/lib/loyalty";
import { moscowDate, type TriggerRule } from "../src/lib/club/contracts";
import {
  scheduleClubTriggers,
  clubTriggerMessage,
} from "../src/lib/club/triggers";
import type { OutboxEvent } from "../src/lib/jobs/telegram";
import { adminRoute } from "../src/lib/api/admin";
import { handle } from "../src/lib/http";
import { randomToken, hashToken } from "../src/lib/auth/session";

const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const actor = { id: "notification-timing-test", role: "admin" as const };
suite("approved notification timing", () => {
  let rules: TriggerRule[], userId: string, admin: string, viewer: string;
  const resources: {
    table: "rentals" | "offers" | "club_content";
    id: string;
  }[] = [];
  beforeAll(async () => {
    rules = await query("SELECT * FROM trigger_rules");
    async function staff(role: string) {
      const token = randomToken();
      const [s] = await query<{ id: string }>(
        "INSERT INTO admin_memberships(auth_user_id,name,email,role) VALUES($1,'Timing QA',$2,$3) RETURNING id",
        [randomUUID(), randomUUID() + "@example.invalid", role],
      );
      await query(
        "INSERT INTO staff_sessions(token_hash,membership_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [hashToken(token), s.id],
      );
      return "rpm_staff=" + token;
    }
    admin = await staff("admin");
    viewer = await staff("viewer");
  });
  beforeEach(async () => {
    await query("UPDATE trigger_rules SET enabled=false,enabled_at=now()");
    userId = "00000000-0000-0000-0000-" + randomBytes(6).toString("hex");
    await query(
      "INSERT INTO users(id,name,status,telegram_id,marketing_consent) VALUES($1,'Timing QA','active',$2,true)",
      [userId, BigInt("0x" + randomBytes(6).toString("hex")).toString()],
    );
    await query(
      "UPDATE loyalty_accounts SET member_since=now()-interval '1 day' WHERE user_id=$1",
      [userId],
    );
  });
  afterEach(async () => {
    for (const r of resources.splice(0)) {
      await query(
        r.table === "rentals"
          ? "UPDATE rentals SET status='cancelled' WHERE id=$1"
          : `UPDATE ${r.table} SET active=false WHERE id=$1`,
        [r.id],
      );
      await query(
        "DELETE FROM deliveries WHERE event_id IN (SELECT id FROM outbox_events WHERE event_type='CLUB_TRIGGER' AND aggregate_id=$1)",
        [r.id],
      );
      await query(
        "DELETE FROM outbox_events WHERE event_type='CLUB_TRIGGER' AND aggregate_id=$1",
        [r.id],
      );
    }
    await query("UPDATE users SET status='blocked' WHERE id=$1", [userId]);
  });
  afterAll(async () => {
    for (const r of rules)
      await query(
        "UPDATE trigger_rules SET enabled=$2,lead_hours=$3,enabled_at=$4 WHERE kind=$1",
        [r.kind, r.enabled, r.lead_hours, r.enabled_at],
      );
    await closePool();
  });
  async function enable(kind: string, hours = 0) {
    await query(
      "UPDATE trigger_rules SET enabled=true,lead_hours=$2 WHERE kind=$1",
      [kind, hours],
    );
  }
  async function rental(pickupAt?: string) {
    const date = pickupAt ? moscowDate(new Date(pickupAt)) : moscowDate();
    const r = await processRental(
      {
        userId,
        externalRentalId: randomUUID(),
        carName: "Timing car",
        startDate: date,
        endDate: date,
        pickupAt,
        amountKopecks: "100000",
        status: "accepted",
        paymentStatus: "unpaid",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    resources.push({ table: "rentals", id: r.rentalId });
    return r.rentalId;
  }
  async function events(id: string) {
    return query<OutboxEvent>(
      "SELECT * FROM outbox_events WHERE event_type='CLUB_TRIGGER' AND aggregate_id=$1 AND user_id=$2 ORDER BY created_at",
      [id, userId],
    );
  }
  async function offer(active = true, future = false) {
    const [r] = await query<{ id: string }>(
      "INSERT INTO offers(title,description,minimum_tier,start_at,end_at,cta_url,active,created_by) VALUES('New offer','Offer text','MEMBER',now()+$2*interval '1 hour',now()+interval '30 days','https://example.invalid',$1,'qa') RETURNING id",
      [active, future ? 2 : -1],
    );
    resources.push({ table: "offers", id: r.id });
    return r.id;
  }
  it("uses actual pickup time, waits until the two-hour window, skips missing time, and deduplicates", async () => {
    await enable("before_rental", 2);
    const due = await rental(new Date(Date.now() + 119 * 60000).toISOString());
    const later = await rental(
      new Date(Date.now() + 121 * 60000).toISOString(),
    );
    const unknown = await rental();
    await scheduleClubTriggers(500);
    await scheduleClubTriggers(500);
    expect(await events(due)).toHaveLength(1);
    expect(await events(later)).toHaveLength(0);
    expect(await events(unknown)).toHaveLength(0);
    expect(
      await clubTriggerMessage((await events(due))[0], false, "MEMBER"),
    ).toContain("Выдача:");
  });
  it("suppresses a queued reminder after rescheduling and schedules the new time once", async () => {
    await enable("before_rental", 2);
    const id = await rental(new Date(Date.now() + 100 * 60000).toISOString());
    await scheduleClubTriggers(500);
    const [old] = await events(id);
    await query(
      "UPDATE rentals SET pickup_at=pickup_at+interval '10 minutes' WHERE id=$1",
      [id],
    );
    expect(await clubTriggerMessage(old, false, "MEMBER")).toBeNull();
    await scheduleClubTriggers(500);
    await scheduleClubTriggers(500);
    const all = await events(id);
    expect(all).toHaveLength(2);
    expect(await clubTriggerMessage(all[1], false, "MEMBER")).toContain(
      "Timing car",
    );
  });
  it("notifies immediately on completion without waiting for payment, only once", async () => {
    await enable("after_rental");
    const id = await rental();
    const [r] = await query<{ version: number }>(
      "SELECT version FROM rentals WHERE id=$1",
      [id],
    );
    await updateRentalStatus(
      {
        rentalId: id,
        status: "completed",
        paymentStatus: "unpaid",
        expectedVersion: r.version,
        reason: "Finished test",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    await scheduleClubTriggers(500);
    const [event] = await events(id);
    expect(event).toBeDefined();
    expect(await clubTriggerMessage(event, false, "MEMBER")).toContain(
      "Timing car",
    );
    const [before] = await query<{ completed_at: Date; version: number }>(
      "SELECT completed_at,version FROM rentals WHERE id=$1",
      [id],
    );
    await updateRentalStatus(
      {
        rentalId: id,
        status: "completed",
        paymentStatus: "paid",
        expectedVersion: before.version,
        reason: "Payment test",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    await scheduleClubTriggers(500);
    expect(await events(id)).toHaveLength(1);
    const [after] = await query<{ completed_at: Date }>(
      "SELECT completed_at FROM rentals WHERE id=$1",
      [id],
    );
    expect(after.completed_at).toEqual(before.completed_at);
  });
  it("announces new offers immediately even with a distant expiry; waits for scheduled publication", async () => {
    await enable("offer_reminder");
    const active = await offer(),
      draft = await offer(false),
      future = await offer(true, true);
    await scheduleClubTriggers(500);
    expect(await events(active)).toHaveLength(1);
    expect(await events(draft)).toHaveLength(0);
    expect(await events(future)).toHaveLength(0);
    await query("UPDATE offers SET active=true WHERE id=$1", [draft]);
    await query(
      "UPDATE offers SET start_at=now()-interval '1 second' WHERE id=$1",
      [future],
    );
    await scheduleClubTriggers(500);
    expect(await events(draft)).toHaveLength(1);
    expect(await events(future)).toHaveLength(1);
    await query(
      "UPDATE offers SET description='Corrected text',version=version+1 WHERE id=$1",
      [active],
    );
    expect(
      await clubTriggerMessage((await events(active))[0], true, "MEMBER"),
    ).toContain("Corrected text");
    await scheduleClubTriggers(500);
    expect(await events(active)).toHaveLength(1);
  });
  it("does not announce old publications when enabling or to customers who joined after publication", async () => {
    const old = await offer();
    await query(
      "UPDATE trigger_rules SET enabled=true,enabled_at=clock_timestamp(),lead_hours=0 WHERE kind='offer_reminder'",
    );
    const fresh = await offer();
    await query(
      "UPDATE loyalty_accounts SET member_since=clock_timestamp() WHERE user_id=$1",
      [userId],
    );
    await scheduleClubTriggers(500);
    expect(await events(old)).toHaveLength(0);
    expect(await events(fresh)).toHaveLength(0);
  });
  it("announces a new route once and uses corrected text in queued delivery", async () => {
    await enable("new_route");
    const [r] = await query<{ id: string }>(
      "INSERT INTO club_content(kind,title,summary,body,active,published_at) VALUES('route','New route','Original','Route details',true,now()) RETURNING id",
    );
    resources.push({ table: "club_content", id: r.id });
    await scheduleClubTriggers(500);
    const [event] = await events(r.id);
    expect(event).toBeDefined();
    await query(
      "UPDATE club_content SET summary='Corrected route',version=version+1 WHERE id=$1",
      [r.id],
    );
    expect(await clubTriggerMessage(event, true, "MEMBER")).toContain(
      "Corrected route",
    );
    expect(await clubTriggerMessage(event, false, "MEMBER")).toBeNull();
    await scheduleClubTriggers(500);
    expect(await events(r.id)).toHaveLength(1);
  });
  it("restricts pickup changes by staff role, origin, rental date, state and version", async () => {
    const pickupAt = new Date(Date.now() + 100 * 60000).toISOString();
    const id = await rental(pickupAt);
    const [r] = await query<{ version: number }>(
      "SELECT version FROM rentals WHERE id=$1",
      [id],
    );
    const origin = process.env.APP_URL || "http://127.0.0.1:3001";
    const list = await adminRoute(
      new Request(origin + "/api/admin/rentals", {
        headers: { cookie: admin },
      }),
      "admin/rentals",
    );
    const listed = (await list!.json()).items.find(
      (item: { id: string }) => item.id === id,
    );
    expect(listed.start_date).toBe(moscowDate(new Date(pickupAt)));
    expect(listed.end_date).toBe(listed.start_date);
    async function change(
      cookie: string,
      body: object,
      requestOrigin = origin,
    ) {
      const path = `admin/rentals/${id}/pickup`;
      return handle(
        async () =>
          (await adminRoute(
            new Request(origin + "/api/" + path, {
              method: "POST",
              headers: {
                cookie,
                origin: requestOrigin,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            }),
            path,
          ))!,
      );
    }
    const input = {
      pickupAt,
      expectedVersion: r.version,
      reason: "Agree pickup time",
    };
    expect((await change(viewer, input)).status).toBe(403);
    expect(
      (await change(admin, input, "https://foreign.example.invalid")).status,
    ).toBe(403);
    expect(
      (
        await change(admin, {
          ...input,
          pickupAt: new Date(Date.parse(pickupAt) + 86400000).toISOString(),
        })
      ).status,
    ).toBe(422);
    expect(
      (await change(admin, { ...input, expectedVersion: r.version + 1 }))
        .status,
    ).toBe(409);
    const response = await change(admin, input);
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.version).toBe(r.version + 1);
    await query("UPDATE rentals SET status='in_progress' WHERE id=$1", [id]);
    expect(
      (await change(admin, { ...input, expectedVersion: saved.version + 1 }))
        .status,
    ).toBe(409);
  });
});
