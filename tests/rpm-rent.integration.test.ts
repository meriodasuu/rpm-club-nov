import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { query, closePool, type Db } from "../src/lib/db";
import {
  bridgeMessage,
  exportRentRequests,
  syncRentStates,
  deliverRentNotifications,
  rentPayload,
} from "../src/lib/club/rpm-rent";

const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const native = new pg.Client({ connectionString: process.env.DATABASE_URL });
const peer: Db = {
  query: async <T>(sql: string, values: unknown[] = []) =>
    (await native.query(sql, values)).rows as T[],
};
let carId: string, userId: string;
const created: string[] = [];
async function request() {
  const id = randomUUID();
  await query(
    `INSERT INTO rental_requests(id,user_id,car_id,car_name,start_date,end_date,days,gross_kopecks,discount_kopecks,total_kopecks,discount_bps,program_version_id,request_key)
    VALUES($1::uuid,$2,$3,'Bridge QA','2035-01-01','2035-01-03',2,2000200,246024,1754176,1230,(SELECT id FROM program_versions ORDER BY effective_at DESC LIMIT 1),$1::text)`,
    [id, userId, carId],
  );
  created.push(id);
  return id;
}
async function row(id: string) {
  return (await query("SELECT * FROM rental_requests WHERE id=$1", [id]))[0];
}
suite("native RPM Rent request bridge", () => {
  beforeAll(async () => {
    await native.connect();
    await native.query("BEGIN");
    await native.query(
      readFileSync("tests/fixtures/rpm-rent-schema.sql", "utf8"),
    );
    await native.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_requests') THEN CREATE ROLE rpm_club_requests NOLOGIN; END IF; END $$",
    );
    await native.query(
      readFileSync("deploy/rpm-rent-requests.sql", "utf8")
        .replace(/^BEGIN;$/m, "")
        .replace(/^COMMIT;$/m, ""),
    );
    await native.query(
      `INSERT INTO public."Car"(id,slug,brand,model,title,category,"bodyType","vehicleClass","shortDescription",description,"pricePerDay",deposit,features,"rentalConditions",published,available,"minimumAge","minimumDrivingExperience","minimumRentalDays","updatedAt") VALUES('bridge-car','bridge-car','QA','Car','Bridge QA','car','sedan','Бизнес','','',10001,10000,'[]','[]',true,true,21,24,1,now())`,
    );
    await native.query(
      `INSERT INTO public."TelegramOperator"(id,username,role,"telegramUserId","updatedAt") VALUES('op1','qa_one','ADMIN','111',now()),('op2','qa_two','OPERATOR','222',now())`,
    );
    [{ id: userId }] = await query<{ id: string }>(
      "INSERT INTO users(name,phone,status,telegram_id,telegram_username) VALUES('Bridge QA','+' || $1::text,'active',$1::bigint,'bridge_qa') RETURNING id",
      [String(Date.now())],
    );
    await query(
      "UPDATE loyalty_accounts SET member_since=now() WHERE user_id=$1",
      [userId],
    );
    [{ id: carId }] = await query<{ id: string }>(
      "INSERT INTO club_content(kind,title,daily_price_kopecks,active,source,source_id) VALUES('car','Bridge QA',1000100,true,'rpm-rent',$1) RETURNING id",
      ["bridge-" + randomUUID()],
    );
    await native.query('UPDATE public."Car" SET id=$1', [
      (
        await query("SELECT source_id FROM club_content WHERE id=$1", [carId])
      )[0].source_id,
    ]);
    await query(
      `UPDATE program_settings SET value='{"enabled":true}' WHERE key='integration:rpm-rent'`,
    );
  });
  afterAll(async () => {
    await query(
      `UPDATE program_settings SET value='{"enabled":false}' WHERE key='integration:rpm-rent'`,
    );
    await query(
      "DELETE FROM rpm_rent_deliveries WHERE request_id=ANY($1::uuid[])",
      [created],
    );
    await query(
      "DELETE FROM rpm_rent_exports WHERE request_id=ANY($1::uuid[])",
      [created],
    );
    await native.query("ROLLBACK");
    await native.end();
    await closePool();
  });
  it("exports once, preserves exact discounted kopecks, retries only failed recipients and syncs cancellation", async () => {
    const id = await request();
    const [queued] = await query(
      "SELECT payload FROM rpm_rent_exports WHERE request_id=$1",
      [id],
    );
    const payload = rentPayload.parse(queued.payload);
    expect(bridgeMessage(payload, 1, "NEW")).toContain("17 541,76 ₽");
    await exportRentRequests(peer);
    expect(await row(id)).toMatchObject({
      rpm_rent_status: "NEW",
      status: "pending",
      rpm_rent_sync_error: null,
    });
    await query(
      "UPDATE rpm_rent_exports SET exported_at=NULL WHERE request_id=$1",
      [id],
    );
    await exportRentRequests(peer);
    expect(
      (await native.query('SELECT count(*) FROM public."Booking"')).rows[0]
        .count,
    ).toBe("1");
    const booking = (await native.query('SELECT * FROM public."Booking"'))
      .rows[0];
    expect(booking.utm.rpm_club_total_kopecks).toBe("1754176");
    expect(booking.originDomain).toBe("club.rpm-rent.ru");
    const send = vi.fn(async (chat: string) => {
      if (chat === "222") throw new Error("offline");
      return 42;
    });
    await deliverRentNotifications(peer, send);
    expect(send).toHaveBeenCalledTimes(2);
    await query(
      "UPDATE rpm_rent_deliveries SET next_attempt_at=now() WHERE request_id=$1",
      [id],
    );
    const retry = vi
      .fn<(chat: string, text: string, number: number) => Promise<number>>()
      .mockResolvedValue(43);
    await deliverRentNotifications(peer, retry);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0]?.[0]).toBe("222");
    await native.query(
      `UPDATE public."Booking" SET status='CONFIRMED',"managerComment"='Private manager note' WHERE id=$1`,
      [booking.id],
    );
    await syncRentStates(peer);
    const accepted = await row(id);
    expect(accepted.status).toBe("accepted");
    expect(accepted.staff_note).toBe("");
    const rental = (
      await query(
        "SELECT status,payment_status,current_amount_kopecks FROM rentals WHERE id=$1",
        [accepted.rental_id],
      )
    )[0];
    expect(rental).toMatchObject({
      status: "accepted",
      payment_status: "unpaid",
      current_amount_kopecks: "1754176",
    });
    await native.query(
      `UPDATE public."Booking" SET status='CANCELLED' WHERE id=$1`,
      [booking.id],
    );
    await syncRentStates(peer);
    expect(await row(id)).toMatchObject({
      status: "cancelled",
      rental_id: accepted.rental_id,
      rpm_rent_sync_error: null,
    });
    expect(
      (
        await query("SELECT status FROM rentals WHERE id=$1", [
          accepted.rental_id,
        ])
      )[0].status,
    ).toBe("cancelled");
  });
  it("keeps failed exports queued and detects immutable snapshot conflicts", async () => {
    const id = await request();
    await exportRentRequests({
      query: async () => {
        throw new Error("source unavailable");
      },
    });
    expect((await row(id)).rpm_rent_sync_error).toBeTruthy();
    await query(
      "UPDATE rpm_rent_exports SET next_attempt_at=now() WHERE request_id=$1",
      [id],
    );
    await exportRentRequests(peer);
    expect((await row(id)).rpm_rent_sync_error).toBeNull();
    const [job] = await query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM rpm_rent_exports WHERE request_id=$1",
      [id],
    );
    await native.query("SAVEPOINT invalid_payload");
    await expect(
      native.query("SELECT rpm_club_requests.receive($1::jsonb)", [
        JSON.stringify({ ...job.payload, phone: "+79990003344" }),
      ]),
    ).rejects.toThrow("BRIDGE_IDEMPOTENCY_CONFLICT");
    await native.query("ROLLBACK TO invalid_payload");
  });
  it("retains conflicting requests as declined inquiries, and does not mark completed bookings paid", async () => {
    const id = await request();
    await exportRentRequests(peer);
    expect(await row(id)).toMatchObject({
      status: "declined",
      rpm_rent_sync_error: null,
    });
    // The previous test reserved these dates; complete its request instead.
    const active = (
      await native.query(
        `SELECT id FROM public."Booking" WHERE status='NEW' LIMIT 1`,
      )
    ).rows[0];
    await native.query(
      `UPDATE public."Booking" SET status='COMPLETED' WHERE id=$1`,
      [active.id],
    );
    await syncRentStates(peer);
    const linked = (
      await query(
        "SELECT rental_id FROM rental_requests WHERE rpm_rent_id=$1",
        [active.id],
      )
    )[0];
    expect(
      (
        await query("SELECT payment_status FROM rentals WHERE id=$1", [
          linked.rental_id,
        ])
      )[0].payment_status,
    ).toBe("unpaid");
  });
  it("limits source access to bridge functions and Club bookings", async () => {
    await native.query("SET LOCAL ROLE rpm_club_requests");
    expect(
      (
        await native.query(
          "SELECT has_table_privilege(current_user,'public.\"Booking\"','SELECT') allowed",
        )
      ).rows[0].allowed,
    ).toBe(false);
    expect(
      (await native.query("SELECT count(*) FROM rpm_club_requests.bookings"))
        .rows[0].count,
    ).toBe("3");
    await native.query("RESET ROLE");
  });
  it("preserves a client cancellation that races with export", async () => {
    const id = await request();
    const racingPeer: Db = {
      query: async <T>(sql: string, values: unknown[] = []) => {
        const result = await peer.query<T>(sql, values);
        if (sql.includes(".receive("))
          await query(
            "UPDATE rental_requests SET status='cancelled' WHERE id=$1",
            [id],
          );
        return result;
      },
    };
    await exportRentRequests(racingPeer);
    expect((await row(id)).status).toBe("cancelled");
    await syncRentStates(peer);
    expect(await row(id)).toMatchObject({
      status: "cancelled",
      rpm_rent_status: "CANCELLED",
      rpm_rent_sync_error: null,
    });
  });
});
