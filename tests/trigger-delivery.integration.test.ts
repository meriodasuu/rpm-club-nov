import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { closePool, query } from "../src/lib/db";
import { moscowDate, type TriggerRule } from "../src/lib/club/contracts";
import { scheduleClubTriggers } from "../src/lib/club/triggers";
import { processRental } from "../src/lib/loyalty";
import { expandOutbox, processJobs } from "../src/lib/jobs";

const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const actor = { id: "trigger-delivery-test", role: "admin" as const };
const appUrl = "https://rpm-trigger-tests.example.invalid";

suite("scheduled club notifications through the Telegram worker", () => {
  let previousRules: (TriggerRule & { updated_at: string })[] = [];
  const resources: { id: string; kind: "rental" | "route" }[] = [];

  beforeAll(async () => {
    previousRules = await query("SELECT * FROM trigger_rules");
  });
  beforeEach(async () => {
    await query("UPDATE trigger_rules SET enabled=false");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-trigger-token-no-network");
    vi.stubEnv("APP_URL", appUrl);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({ ok: true, result: { message_id: 1 } }),
              { status: 200 },
            ),
        ),
    );
  });
  afterEach(async () => {
    try {
      for (const resource of resources.splice(0)) {
        if (resource.kind === "route") {
          await query("UPDATE club_content SET active=false WHERE id=$1", [
            resource.id,
          ]);
        } else {
          await query("UPDATE rentals SET status='cancelled' WHERE id=$1", [
            resource.id,
          ]);
        }
        // Delete only this test's queue records, including other synthetic recipients
        // selected by the real scheduler. Never process unrelated pending deliveries.
        await query(
          "DELETE FROM deliveries WHERE event_id IN (SELECT id FROM outbox_events WHERE event_type='CLUB_TRIGGER' AND aggregate_id=$1)",
          [resource.id],
        );
        await query(
          "DELETE FROM outbox_events WHERE event_type='CLUB_TRIGGER' AND aggregate_id=$1",
          [resource.id],
        );
      }
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  afterAll(async () => {
    try {
      for (const rule of previousRules) {
        await query(
          "UPDATE trigger_rules SET enabled=$2,message=$3,lead_hours=$4,city=$5,latitude=$6,longitude=$7,updated_at=$8 WHERE kind=$1",
          [
            rule.kind,
            rule.enabled,
            rule.message,
            rule.lead_hours,
            rule.city,
            rule.latitude,
            rule.longitude,
            rule.updated_at,
          ],
        );
      }
    } finally {
      await closePool();
    }
  });

  async function member() {
    const telegram = BigInt("0x" + randomBytes(6).toString("hex")).toString();
    // Keep the fixture in the first bounded scheduler page, even on a reused test DB.
    const id = "00000000-0000-0000-0000-" + randomBytes(6).toString("hex");
    await query(
      "INSERT INTO users(id,name,status,telegram_id,marketing_consent) VALUES($1,'Synthetic trigger delivery','active',$2,true)",
      [id, telegram],
    );
    await query(
      "UPDATE loyalty_accounts SET member_since=now()-interval '1 day' WHERE user_id=$1",
      [id],
    );
    return { id, telegram };
  }

  async function beforeRental() {
    const user = await member(),
      date = moscowDate(new Date(Date.now() + 86400000));
    const rental = await processRental(
      {
        userId: user.id,
        externalRentalId: randomUUID(),
        carName: "Synthetic trigger car",
        startDate: date,
        pickupAt: date + "T12:00:00+03:00",
        endDate: date,
        amountKopecks: "100000",
        status: "accepted",
        paymentStatus: "unpaid",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    resources.push({ id: rental.rentalId, kind: "rental" });
    await query(
      "UPDATE trigger_rules SET enabled=true,lead_hours=168,message='Напоминание о вашей поездке.' WHERE kind='before_rental'",
    );
    await scheduleClubTriggers(500);
    const events = await query<{ id: string }>(
      "SELECT id FROM outbox_events WHERE event_type='CLUB_TRIGGER' AND aggregate_id=$1 AND user_id=$2 AND payload->>'kind'='before_rental'",
      [rental.rentalId, user.id],
    );
    expect(events).toHaveLength(1);
    return { user, date, rentalId: rental.rentalId, eventId: events[0].id };
  }

  it("sends a scheduled rental reminder once despite repeated scheduler and worker runs", async () => {
    const f = await beforeRental();
    const result = await processJobs({
      eventIds: [f.eventId],
      maintenance: false,
    });
    expect(result).toMatchObject({
      succeeded: 1,
      suppressed: 0,
      retry: 0,
      dead: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe(
      "https://api.telegram.org/botsynthetic-trigger-token-no-network/sendMessage",
    );
    const message = JSON.parse(String(init?.body));
    expect(message.chat_id).toBe(f.user.telegram);
    expect(message.text).toContain("Напоминание о вашей поездке.");
    expect(message.text).toContain(
      `Synthetic trigger car · ${f.date} — ${f.date}`,
    );
    expect(message.reply_markup.inline_keyboard[0][0].web_app.url).toBe(appUrl);
    await scheduleClubTriggers(500);
    expect(
      await query(
        "SELECT id FROM outbox_events WHERE event_type='CLUB_TRIGGER' AND aggregate_id=$1 AND user_id=$2",
        [f.rentalId, f.user.id],
      ),
    ).toHaveLength(1);
    expect(
      await processJobs({ eventIds: [f.eventId], maintenance: false }),
    ).toMatchObject({ expanded: 0, succeeded: 0, retry: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      (
        await query<{ status: string; attempts: number }>(
          "SELECT status,attempts FROM deliveries WHERE event_id=$1",
          [f.eventId],
        )
      )[0],
    ).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  it("suppresses an already expanded reminder when its rental is cancelled", async () => {
    const f = await beforeRental();
    await expandOutbox(10, [f.eventId]);
    await query("UPDATE rentals SET status='cancelled' WHERE id=$1", [
      f.rentalId,
    ]);
    expect(
      await processJobs({ eventIds: [f.eventId], maintenance: false }),
    ).toMatchObject({ succeeded: 0, suppressed: 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (
        await query<{ status: string }>(
          "SELECT status FROM deliveries WHERE event_id=$1",
          [f.eventId],
        )
      )[0].status,
    ).toBe("suppressed");
  });

  it("rechecks marketing consent before delivering a scheduled new route", async () => {
    const user = await member();
    const routeId = "00000000-0000-0000-0000-" + randomBytes(6).toString("hex");
    await query(
      "INSERT INTO club_content(id,kind,title,body,active,published_at) VALUES($1,'route','Synthetic trigger route','Route details',true,now())",
      [routeId],
    );
    resources.push({ id: routeId, kind: "route" });
    await query("UPDATE trigger_rules SET enabled=true WHERE kind='new_route'");
    await scheduleClubTriggers(500);
    const [event] = await query<{ id: string }>(
      "SELECT id FROM outbox_events WHERE event_type='CLUB_TRIGGER' AND aggregate_id=$1 AND user_id=$2",
      [routeId, user.id],
    );
    expect(event).toBeDefined();
    await expandOutbox(10, [event.id]);
    await query("UPDATE users SET marketing_consent=false WHERE id=$1", [
      user.id,
    ]);
    expect(
      await processJobs({ eventIds: [event.id], maintenance: false }),
    ).toMatchObject({ succeeded: 0, suppressed: 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (
        await query<{ status: string }>(
          "SELECT status FROM deliveries WHERE event_id=$1",
          [event.id],
        )
      )[0].status,
    ).toBe("suppressed");
  });
});
