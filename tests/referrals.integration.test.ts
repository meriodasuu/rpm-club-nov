import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminRoute } from "../src/lib/api/admin";
import { clientRoute } from "../src/lib/api/client";
import { handle } from "../src/lib/http";
import { hashToken, randomToken } from "../src/lib/auth/session";
import { maintenanceStage } from "../src/lib/jobs/diagnostics";
import { query, transaction, closePool } from "../src/lib/db";
import {
  bindReferral,
  processRental,
  updateRentalStatus,
  cancelRental,
  retryReferrals,
  getAccountSnapshot,
  type RentalInput,
} from "../src/lib/loyalty";
import {
  getReferralProgram,
  publishReferralProgram,
  issueReferralAward,
} from "../src/lib/referrals";
import type { ReferralAward } from "../src/lib/referrals/contracts";
const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const actor = {
  id: "manual-referral-test-" + randomUUID(),
  role: "admin" as const,
};
const key = () => randomUUID();
async function pair() {
  const users = await query<{ id: string; referral_code: string }>(
    "INSERT INTO users(name,status,phone) VALUES('Referral test inviter','active',$1),('Referral test friend','active',$2) RETURNING id,referral_code",
    [
      "+7" +
        BigInt("0x" + key().replaceAll("-", "").slice(0, 10))
          .toString()
          .padStart(10, "0"),
      "+7" +
        BigInt("0x" + key().replaceAll("-", "").slice(0, 10))
          .toString()
          .padStart(10, "0"),
    ],
  );
  await bindReferral(
    { userId: users[1].id, code: users[0].referral_code },
    actor,
  );
  return { referrer: users[0].id, referred: users[1].id };
}
function rental(userId: string): RentalInput {
  return {
    userId,
    externalRentalId: key(),
    carName: "Referral test car",
    startDate: "2026-09-01",
    endDate: "2026-09-02",
    qualifiedAt: new Date().toISOString(),
    amountKopecks: "100000",
    status: "completed",
    paymentStatus: "paid",
    mode: "operational",
    idempotencyKey: key(),
  };
}
async function policy(title = "Подарок", enabled = true) {
  return publishReferralProgram(
    {
      enabled,
      referrer: { title, terms: "Получить у менеджера" },
      referred: { title: "Доставка", terms: "Одна доставка в пределах города" },
      expectedVersion: (await getReferralProgram())?.version ?? 0,
      reason: "Тест условий",
    },
    key(),
    actor,
  );
}
async function awards(userId: string) {
  return query<ReferralAward>(
    "SELECT w.* FROM referral_manual_awards w JOIN referrals r ON r.id=w.referral_id WHERE r.referred_id=$1 ORDER BY w.side",
    [userId],
  );
}
suite("manual referral rewards in PostgreSQL", () => {
  it("denies a viewer issuance and a manager publication at the API boundary", async () => {
    const users = await pair();
    await processRental(rental(users.referred), actor);
    const [award] = await awards(users.referred);
    for (const [role, path, payload] of [
      [
        "viewer",
        `admin/referral-awards/${award.id}/issue`,
        { confirmed: true, comment: "Выдано" },
      ],
      ["manager", "admin/referral-program", {}],
    ] as const) {
      const token = randomToken();
      const [member] = await query<{ id: string }>(
        "INSERT INTO admin_memberships(auth_user_id,email,name,role) VALUES($1,$2,'Role test',$3) RETURNING id",
        [key(), key() + "@example.invalid", role],
      );
      await query(
        "INSERT INTO staff_sessions(token_hash,membership_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [hashToken(token), member.id],
      );
      const request = new Request("http://127.0.0.1:3001/api/" + path, {
        method: "POST",
        headers: {
          cookie: "rpm_staff=" + token,
          origin: "http://127.0.0.1:3001",
          "content-type": "application/json",
          "idempotency-key": key(),
        },
        body: JSON.stringify(payload),
      });
      const response = await handle(
        async () =>
          (await adminRoute(request, path)) ??
          new Response(null, { status: 404 }),
      );
      expect(response.status).toBe(403);
    }
  });
  it("resolves only errors from the successfully completed maintenance stage", async () => {
    const [failed] = await query<{ id: string }>(
      "INSERT INTO operational_errors(kind,details) VALUES('job_maintenance',$1) RETURNING id",
      [JSON.stringify({ stage: "test-success", code: "42P01" })],
    );
    const [other] = await query<{ id: string }>(
      "INSERT INTO operational_errors(kind,details) VALUES('job_maintenance',$1) RETURNING id",
      [JSON.stringify({ stage: "test-other", code: "42P01" })],
    );
    await maintenanceStage(
      "test-success",
      async () => 1,
      new Date().toISOString(),
    );
    expect(
      (
        await query<{ resolved_at: string }>(
          "SELECT resolved_at FROM operational_errors WHERE id=$1",
          [failed.id],
        )
      )[0].resolved_at,
    ).toBeTruthy();
    expect(
      (
        await query<{ resolved_at: string }>(
          "SELECT resolved_at FROM operational_errors WHERE id=$1",
          [other.id],
        )
      )[0].resolved_at,
    ).toBeNull();
    await expect(
      maintenanceStage(
        "test-other",
        async () => {
          throw { code: "42P01", message: "secret" };
        },
        new Date().toISOString(),
      ),
    ).rejects.toMatchObject({ stage: "test-other", safeCode: "42P01" });
  });
  let oldRental: Awaited<ReturnType<typeof processRental>>;
  let oldPair: Awaited<ReturnType<typeof pair>>;
  beforeAll(async () => {
    oldPair = await pair();
    oldRental = await processRental(
      {
        ...rental(oldPair.referred),
        status: "accepted",
        paymentStatus: "unpaid",
      },
      actor,
    );
    await policy();
  });
  afterAll(async () => {
    // Only this suite's synthetic records in the dedicated test database.
    await transaction(async (tx) => {
      await tx.query("ALTER TABLE referral_manual_awards DISABLE TRIGGER USER");
      await tx.query(
        "DELETE FROM referral_manual_awards WHERE program_version_id IN (SELECT id FROM referral_program_versions WHERE created_by=$1)",
        [actor.id],
      );
      await tx.query(
        "UPDATE referrals SET manual_version_id=NULL,status='ineligible' WHERE manual_version_id IN (SELECT id FROM referral_program_versions WHERE created_by=$1)",
        [actor.id],
      );
      await tx.query(
        "ALTER TABLE referral_program_versions DISABLE TRIGGER USER",
      );
      await tx.query(
        "DELETE FROM referral_program_versions WHERE created_by=$1",
        [actor.id],
      );
      await tx.query(
        "ALTER TABLE referral_program_versions ENABLE TRIGGER USER",
      );
      await tx.query("ALTER TABLE referral_manual_awards ENABLE TRIGGER USER");
    });
    await closePool();
  });
  it("does not rewrite old rentals and preserves their legacy rewards", async () => {
    const [before] = await query("SELECT * FROM rentals WHERE id=$1", [
      oldRental.rentalId,
    ]);
    await policy("Другая награда");
    expect(
      (
        await query("SELECT * FROM rentals WHERE id=$1", [oldRental.rentalId])
      )[0],
    ).toEqual(before);
    await updateRentalStatus(
      {
        rentalId: oldRental.rentalId,
        status: "completed",
        paymentStatus: "paid",
        expectedVersion: Number(before.version),
        reason: "Тест оплаты",
        idempotencyKey: key(),
      },
      actor,
    );
    expect(await awards(oldPair.referred)).toHaveLength(0);
    expect(
      BigInt((await getAccountSnapshot(oldPair.referrer)).bonus_available),
    ).toBeGreaterThan(0n);
  });
  it("creates exactly two snapshotted rewards with no referral Bonus and issues concurrently once", async () => {
    const users = await pair(),
      input = rental(users.referred);
    await Promise.all([
      processRental(input, actor),
      processRental({ ...input, idempotencyKey: key() }, actor),
    ]);
    const rows = await awards(users.referred);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect((await getAccountSnapshot(users.referrer)).bonus_available).toBe(
      "0",
    );
    await policy("Изменённая награда");
    expect((await awards(users.referred)).map((r) => r.title)).toEqual(
      rows.map((r) => r.title),
    );
    const inputIssue = { confirmed: true, comment: "Выдано лично" };
    await Promise.all([
      issueReferralAward(rows[0].id, inputIssue, key(), actor),
      issueReferralAward(rows[0].id, inputIssue, key(), actor),
    ]);
    expect(
      await query(
        "SELECT id FROM audit_logs WHERE entity_id=$1 AND action='referral_award.issue'",
        [rows[0].id],
      ),
    ).toHaveLength(1);
    await expect(
      query("UPDATE referral_manual_awards SET title='rewrite' WHERE id=$1", [
        rows[0].id,
      ]),
    ).rejects.toThrow("immutable");
    await expect(
      query("UPDATE referral_program_versions SET enabled=false WHERE id=$1", [
        rows[0].program_version_id,
      ]),
    ).rejects.toThrow("append-only");
  });
  it("cancel before/after issuance preserves evidence and never debits Bonus for a manual gift", async () => {
    const users = await pair(),
      r = await processRental(rental(users.referred), actor),
      rows = await awards(users.referred);
    await issueReferralAward(
      rows[0].id,
      { confirmed: true, comment: "Подарок получен" },
      key(),
      actor,
    );
    await cancelRental(
      { rentalId: r.rentalId, reason: "Отмена аренды", idempotencyKey: key() },
      actor,
    );
    const after = await awards(users.referred);
    expect(after.map((r) => r.status)).toEqual(["review", "cancelled"]);
    expect(after[0].issued_at).toBeTruthy();
    await expect(
      issueReferralAward(
        rows[1].id,
        { confirmed: true, comment: "Повторная выдача" },
        key(),
        actor,
      ),
    ).rejects.toMatchObject({ code: "AWARD_UNAVAILABLE" });
    expect((await getAccountSnapshot(users.referrer)).bonus_debt).toBe("0");
  });
  it("holds blocked users, retains the version, and resumes idempotently", async () => {
    const users = await pair();
    await query("UPDATE users SET status='blocked' WHERE id=$1", [
      users.referrer,
    ]);
    const version = await getReferralProgram();
    await processRental(rental(users.referred), actor);
    expect(await awards(users.referred)).toHaveLength(0);
    await policy("Новая версия после блокировки");
    await query("UPDATE users SET status='active' WHERE id=$1", [
      users.referrer,
    ]);
    await retryReferrals();
    await retryReferrals();
    const rows = await awards(users.referred);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.program_version_id === version?.id)).toBe(
      true,
    );
  });
  it("requires completed and paid; excludes history, second rentals, and disabled program", async () => {
    const users = await pair();
    const pending = await processRental(
      { ...rental(users.referred), paymentStatus: "unpaid" },
      actor,
    );
    expect(await awards(users.referred)).toHaveLength(0);
    const [row] = await query<{ version: number }>(
      "SELECT version FROM rentals WHERE id=$1",
      [pending.rentalId],
    );
    await updateRentalStatus(
      {
        rentalId: pending.rentalId,
        status: "completed",
        paymentStatus: "paid",
        expectedVersion: row.version,
        reason: "Оплата",
        idempotencyKey: key(),
      },
      actor,
    );
    expect(await awards(users.referred)).toHaveLength(2);
    await processRental(rental(users.referred), actor);
    expect(await awards(users.referred)).toHaveLength(2);
    const historical = await pair();
    await processRental(
      { ...rental(historical.referred), mode: "historical" },
      actor,
    );
    expect(await awards(historical.referred)).toHaveLength(0);
    await policy("Выключено", false);
    const disabled = await pair();
    await processRental(rental(disabled.referred), actor);
    expect(await awards(disabled.referred)).toHaveLength(0);
    expect((await getAccountSnapshot(disabled.referrer)).bonus_available).toBe(
      "0",
    );
    await policy();
  });
  it("rejects unauthorized publishing, stale edits, unknown award and unconfirmed issuance", async () => {
    const p = await getReferralProgram();
    const input = {
      enabled: true,
      referrer: p!.referrer,
      referred: p!.referred,
      expectedVersion: p!.version,
      reason: "Проверка прав",
    };
    await expect(
      publishReferralProgram(input, key(), { id: actor.id, role: "manager" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      publishReferralProgram({ ...input, expectedVersion: 0 }, key(), actor),
    ).rejects.toMatchObject({ code: "REFERRAL_STALE" });
    await expect(
      issueReferralAward(
        key(),
        { confirmed: true, comment: "Выдано" },
        key(),
        actor,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      issueReferralAward(
        key(),
        { confirmed: false, comment: "Выдано" },
        key(),
        actor,
      ),
    ).rejects.toThrow();
  });
  it("serializes issuance against cancellation and exposes only the member's own awards", async () => {
    const users = await pair(),
      r = await processRental(rental(users.referred), actor),
      rows = await awards(users.referred);
    const results = await Promise.allSettled([
      issueReferralAward(
        rows[0].id,
        { confirmed: true, comment: "Получено лично" },
        key(),
        actor,
      ),
      cancelRental(
        {
          rentalId: r.rentalId,
          reason: "Возврат аренды",
          idempotencyKey: key(),
        },
        actor,
      ),
    ]);
    expect(results[1].status).toBe("fulfilled");
    expect(
      (await awards(users.referred)).every((row) =>
        ["cancelled", "review"].includes(row.status),
      ),
    ).toBe(true);
    const token = randomToken();
    await query(
      "INSERT INTO miniapp_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [users.referred, hashToken(token)],
    );
    const response = await clientRoute(
      new Request("http://127.0.0.1:3001/api/me/referral", {
        headers: { cookie: "rpm_session=" + token },
      }),
      "me/referral",
    );
    const payload = await response!.json();
    expect(payload.awards).toHaveLength(1);
    expect(payload.awards[0].id).toBe(
      rows.find((row) => row.beneficiary_user_id === users.referred)!.id,
    );
    expect(payload.program).not.toHaveProperty("created_by");
    expect(payload.program).not.toHaveProperty("reason");
    expect(payload.awards[0]).not.toHaveProperty("issued_by");
  });
});
