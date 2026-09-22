import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Db } from "../src/lib/db";

// Keep real HTTP handlers and real SQL while rolling back published, immutable
// program versions. A sixth level must not leak into unrelated legacy tests.
const scope = vi.hoisted(() => ({ current: undefined as Db | undefined }));
vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return {
    ...actual,
    query: <T>(sql: string, values: unknown[] = []) =>
      scope.current
        ? scope.current.query<T>(sql, values)
        : actual.query<T>(sql, values),
    transaction: <T>(work: (tx: Db) => Promise<T>) =>
      scope.current ? work(scope.current) : actual.transaction(work),
  };
});

import { closePool, query, transaction } from "../src/lib/db";
import { adminRoute } from "../src/lib/api/admin";
import { handle } from "../src/lib/http";
import { hashToken, randomToken } from "../src/lib/auth/session";
import {
  getProgram,
  resolveProgramStartsAt,
  type Program,
  type TierRule,
} from "../src/lib/loyalty";

const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const base = "http://127.0.0.1:3001";
async function rollback(work: () => Promise<void>) {
  const marker = new Error("ROLLBACK_PROGRAM_ADMIN_TEST");
  try {
    await transaction(async (tx) => {
      scope.current = tx;
      try {
        await work();
      } finally {
        scope.current = undefined;
      }
      throw marker;
    });
  } catch (error) {
    if (error !== marker) throw error;
  }
}
async function staff(role = "admin") {
  const token = randomToken();
  const [m] = await query<{ id: string }>(
    "INSERT INTO admin_memberships(auth_user_id,name,email,role) VALUES($1,'Program API QA',$2,$3) RETURNING id",
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
  cookie: string,
  data?: unknown,
  key = randomUUID(),
) {
  const request = new Request(base + "/api/" + path, {
    method: data === undefined ? "GET" : "POST",
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
      (await adminRoute(request, path)) ?? new Response(null, { status: 404 }),
  );
}
async function member() {
  return (
    await query<{ id: string }>(
      "INSERT INTO users(name,status) VALUES('Program API synthetic','active') RETURNING id",
    )
  )[0].id;
}
function sixthTier(program: Program): TierRule[] {
  return program.tiers.flatMap((t) =>
    t.code === "BLACK"
      ? [
          t,
          {
            code: "PLATINUM" as const,
            thresholdKopecks: "50000000",
            rateBps: 600,
            displayName: "Тестовый подуровень",
            color: "diamond" as const,
            benefits: ["Тестовая привилегия"],
          },
        ]
      : [t],
  );
}

suite("program publication through the admin HTTP API", () => {
  const previousUrl = process.env.APP_URL;
  beforeAll(() => {
    process.env.APP_URL = base;
  });
  afterAll(async () => {
    process.env.APP_URL = previousUrl;
    await closePool();
  });

  it("publishes six levels and permits assigning the published sublevel", async () =>
    rollback(async () => {
      const cookie = await staff(),
        userId = await member(),
        original = await getProgram();
      expect(original.tiers).toHaveLength(5);
      const credit = await call("admin/bonus/credit", cookie, {
        userId,
        amount: "1234",
        reason: "Preserve existing Bonus during publication",
      });
      expect(credit.status).toBe(200);
      const payload = {
          ...original,
          rewardMode: "discount",
          tiers: sixthTier(original),
          reason: "API publication regression",
        },
        key = randomUUID();
      const published = await call(
        "admin/program-versions",
        cookie,
        payload,
        key,
      );
      expect(published.status).toBe(200);
      const program: Program = await published.json();
      expect(program.tiers).toHaveLength(6);
      expect(program.rewardMode).toBe("discount");
      expect(
        (
          await (
            await call("admin/program-versions", cookie, payload, key)
          ).json()
        ).id,
      ).toBe(program.id);
      const assigned = await call(`admin/customers/${userId}/tier`, cookie, {
        tier: "PLATINUM",
        reason: "Published level",
      });
      expect(assigned.status).toBe(200);
      expect(await assigned.json()).toMatchObject({
        tier: "PLATINUM",
        discount_rate_bps: 600,
        bonus_available: "1234",
      });
      const settings = await (await call("admin/settings", cookie)).json();
      expect(
        settings.program.tiers.find((t: TierRule) => t.code === "PLATINUM")
          .displayName,
      ).toBe("Тестовый подуровень");
      const removal = await call("admin/program-versions", cookie, {
        ...original,
        rewardMode: "discount",
        reason: "Cannot remove a published level",
      });
      expect((await removal.json()).code).toBe("TIER_REMOVAL");
    }));

  it("publishes unchanged start date after a paid rental but rejects an actual date change", async () =>
    rollback(async () => {
      const cookie = await staff(),
        userId = await member(),
        program = await getProgram();
      const now = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
      const rental = await call("admin/rentals", cookie, {
        userId,
        externalRentalId: randomUUID(),
        carName: "Program date QA",
        startDate: now,
        endDate: now,
        amountKopecks: "10000",
        status: "completed",
        paymentStatus: "paid",
        reason: "Start date lock regression",
      });
      expect(rental.status).toBe(201);
      const date = new Date(Date.parse(program.programStartsAt) + 3 * 3600000)
        .toISOString()
        .slice(0, 10);
      const unchanged = await call("admin/program-versions", cookie, {
        ...program,
        rewardMode: "discount",
        programStartsAt: resolveProgramStartsAt(date, program.programStartsAt),
        reason: "Publish unchanged start date",
      });
      expect(unchanged.status).toBe(200);
      expect((await unchanged.json()).programStartsAt).toBe(
        program.programStartsAt,
      );
      const changedDate = new Date(Date.parse(date) + 86400000)
        .toISOString()
        .slice(0, 10);
      const changed = await call("admin/program-versions", cookie, {
        ...program,
        rewardMode: "discount",
        programStartsAt: resolveProgramStartsAt(
          changedDate,
          program.programStartsAt,
        ),
        reason: "Reject changed start date",
      });
      expect((await changed.json()).code).toBe("START_DATE_LOCKED");
    }));

  it("rejects assignment of an unpublished sublevel", async () =>
    rollback(async () => {
      const cookie = await staff(),
        userId = await member();
      expect(
        (await getProgram()).tiers.some((t) => t.code === "PLATINUM"),
      ).toBe(false);
      const unavailable = await call(`admin/customers/${userId}/tier`, cookie, {
        tier: "PLATINUM",
        reason: "Unpublished level",
      });
      expect(unavailable.status).toBe(400);
      expect((await unavailable.json()).code).toBe("INVALID_TIER");
    }));

  it("rejects publishing cashback through the current admin API", async () =>
    rollback(async () => {
      const result = await call("admin/program-versions", await staff(), {
        ...(await getProgram()),
        rewardMode: "cashback",
        reason: "Retired mechanic must stay unavailable",
      });
      expect(result.status).toBe(422);
      expect((await result.json()).code).toBe("VALIDATION_ERROR");
    }));

  it("keeps program publication restricted to admins", async () =>
    rollback(async () => {
      const program = await getProgram();
      for (const role of ["viewer", "manager"]) {
        const result = await call("admin/program-versions", await staff(role), {
          ...program,
          reason: "Forbidden publication",
        });
        expect(result.status).toBe(403);
      }
    }));
});
