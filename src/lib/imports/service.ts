import { randomUUID } from "node:crypto";
import { query, transaction } from "@/lib/db";
import { getProgram, processRental } from "@/lib/loyalty";
import type { Actor } from "@/lib/loyalty/types";
import { HttpError } from "@/lib/http";
import {
  normalizeRentalRow,
  parseFile,
  type ImportProfile,
  type NormalizedRental,
} from "./parser";

export async function resolveCustomer(row: NormalizedRental, source: string) {
  return transaction(async (tx) => {
    for (const lock of [
      "phone:" + row.phone,
      ...(row.crmCustomerId ? ["crm:" + row.crmCustomerId] : []),
    ].sort())
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
    const matches = await tx.query<{
      id: string;
      phone: string;
      crm_customer_id: string | null;
    }>(
      "SELECT id,phone,crm_customer_id FROM users WHERE phone=$1 OR ($2::text IS NOT NULL AND crm_customer_id=$2) FOR UPDATE",
      [row.phone, row.crmCustomerId],
    );
    if (
      matches.length > 1 ||
      matches.some((m) => m.phone && m.phone !== row.phone)
    )
      throw new HttpError(
        409,
        "IDENTITY_CONFLICT",
        "Телефон и CRM ID относятся к разным клиентам",
      );
    if (
      matches[0]?.crm_customer_id &&
      row.crmCustomerId &&
      matches[0].crm_customer_id !== row.crmCustomerId
    )
      throw new HttpError(
        409,
        "IDENTITY_CONFLICT",
        "CRM ID не соответствует клиенту",
      );
    let id = matches[0]?.id;
    if (!id) {
      id = randomUUID();
      await tx.query(
        "INSERT INTO users(id,name,phone,crm_customer_id,status) VALUES($1,$2,$3,$4,'pending')",
        [id, row.customerName, row.phone, row.crmCustomerId],
      );
    }
    if (row.crmCustomerId) {
      const [identity] = await tx.query<{ user_id: string }>(
        "SELECT user_id FROM customer_external_identities WHERE source=$1 AND crm_customer_id=$2",
        [source, row.crmCustomerId],
      );
      if (identity && identity.user_id !== id)
        throw new HttpError(
          409,
          "IDENTITY_CONFLICT",
          "Внешняя связь клиента уже занята",
        );
      await tx.query(
        "UPDATE users SET crm_customer_id=COALESCE(crm_customer_id,$2),phone=COALESCE(phone,$3) WHERE id=$1",
        [id, row.crmCustomerId, row.phone],
      );
      const [bound] = await tx.query<{ user_id: string }>(
        "INSERT INTO customer_external_identities(source,crm_customer_id,user_id) VALUES($1,$2,$3) ON CONFLICT(source,crm_customer_id) DO UPDATE SET crm_customer_id=excluded.crm_customer_id RETURNING user_id",
        [source, row.crmCustomerId, id],
      );
      if (bound.user_id !== id)
        throw new HttpError(
          409,
          "IDENTITY_CONFLICT",
          "Внешняя связь клиента уже занята",
        );
    }
    return id;
  });
}
export async function previewImport(
  buffer: Buffer,
  filename: string,
  mode: "historical" | "operational",
  profile: ImportProfile,
  actor: Actor,
) {
  if (mode === "historical" && actor.role !== "admin")
    throw new HttpError(
      403,
      "HISTORICAL_ADMIN",
      "Исторический перенос доступен администратору",
    );
  if (profile.legacyCompletedPaid && actor.role !== "admin")
    throw new HttpError(
      403,
      "LEGACY_ADMIN",
      "Профиль подтверждения оплаты настраивает администратор",
    );
  const raw = await parseFile(buffer, filename, profile);
  if (raw.length > 10000 || raw.length === 0)
    throw new HttpError(
      422,
      "ROW_LIMIT",
      "Файл должен содержать от 1 до 10 000 строк",
    );
  const program = await getProgram();
  const batchId = randomUUID();
  const seen = new Set<string>();
  const rows = raw.map((r, index) => {
    try {
      const normalized = normalizeRentalRow(r, profile);
      if (seen.has(normalized.externalRentalId))
        throw new Error("Повтор ID внутри файла");
      seen.add(normalized.externalRentalId);
      return {
        row: index + 2,
        payload: normalized,
        status: "valid",
        errors: [] as string[],
      };
    } catch (e) {
      return {
        row: index + 2,
        payload: r,
        status: "invalid",
        errors: [e instanceof Error ? e.message : "Некорректная строка"],
      };
    }
  });
  const existing = await query<{
    external_rental_id: string;
    phone: string;
    crm_customer_id: string | null;
    car_name: string;
    start_date: string;
    end_date: string;
    amount_kopecks: string;
    status: string;
    payment_status: string;
    mode: string;
    is_qualified: boolean;
    qualified_at: Date;
  }>(
    `SELECT r.*,r.start_date::text,r.end_date::text,u.phone,u.crm_customer_id FROM rentals r JOIN users u ON u.id=r.user_id WHERE r.external_rental_id=ANY($1::text[])`,
    [[...seen]],
  );
  const byId = new Map(existing.map((r) => [r.external_rental_id, r]));
  const normalized = rows
    .filter((r) => r.status === "valid")
    .map((r) => r.payload as NormalizedRental);
  const identities = await query<{
    id: string;
    phone: string | null;
    crm_customer_id: string | null;
  }>(
    "SELECT id,phone,crm_customer_id FROM users WHERE phone=ANY($1::text[]) OR crm_customer_id=ANY($2::text[])",
    [
      normalized.map((r) => r.phone),
      normalized.map((r) => r.crmCustomerId).filter(Boolean),
    ],
  );
  const fileCrm = new Map<string, string>();
  for (const row of rows) {
    if (row.status !== "valid") continue;
    const p = row.payload as NormalizedRental;
    const matches = identities.filter(
      (u) =>
        u.phone === p.phone ||
        (!!p.crmCustomerId && u.crm_customer_id === p.crmCustomerId),
    );
    if (
      matches.length > 1 ||
      matches.some(
        (u) =>
          (u.phone && u.phone !== p.phone) ||
          (p.crmCustomerId &&
            u.crm_customer_id &&
            u.crm_customer_id !== p.crmCustomerId),
      ) ||
      (p.crmCustomerId &&
        fileCrm.has(p.crmCustomerId) &&
        fileCrm.get(p.crmCustomerId) !== p.phone)
    ) {
      row.status = "invalid";
      row.errors = ["Телефон и CRM ID относятся к разным клиентам"];
    }
    if (p.crmCustomerId) fileCrm.set(p.crmCustomerId, p.phone);
  }
  for (const row of rows) {
    if (row.status !== "valid") continue;
    const p = row.payload as NormalizedRental,
      r = byId.get(p.externalRentalId);
    if (!r) continue;
    const same =
      r.phone === p.phone &&
      (!p.crmCustomerId || r.crm_customer_id === p.crmCustomerId) &&
      r.car_name === p.carName &&
      r.start_date === p.startDate &&
      r.end_date === p.endDate &&
      r.amount_kopecks === p.amountKopecks &&
      r.mode === mode;
    const state =
      r.status === p.status &&
      r.payment_status === p.paymentStatus &&
      (!p.qualifiedAt ||
        new Date(r.qualified_at).getTime() === Date.parse(p.qualifiedAt));
    if (same && state) row.status = "duplicate";
    else if (!same || r.is_qualified || r.status === "cancelled") {
      row.status = "invalid";
      row.errors = [
        "ID уже существует с другими данными. Используйте корректировку аренды.",
      ];
    }
  }
  await transaction(async (tx) => {
    await tx.query(
      "INSERT INTO import_batches(id,filename,mode,profile,program_version_id,status,created_by) VALUES($1,$2,$3,$4,$5,'validated',$6)",
      [
        batchId,
        filename.slice(0, 200),
        mode,
        JSON.stringify(profile),
        program.id,
        actor.id,
      ],
    );
    for (const row of rows) {
      const p = row.payload as NormalizedRental;
      const classification =
        row.status === "valid"
          ? p.status === "completed" && p.paymentStatus === "paid"
            ? "new"
            : "nonqualifying"
          : row.status;
      await tx.query(
        "INSERT INTO import_rows(batch_id,row_number,payload,status,errors,result) VALUES($1,$2,$3,$4,$5,$6)",
        [
          batchId,
          row.row,
          JSON.stringify(row.payload),
          row.status,
          JSON.stringify(row.errors),
          JSON.stringify({ classification }),
        ],
      );
    }
    await tx.query(
      "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES($1,$2,'import.preview','import',$3,'Проверка файла',$4)",
      [
        actor.id,
        actor.role,
        batchId,
        JSON.stringify({ filename, mode, profile, rows: rows.length }),
      ],
    );
  });
  return getImport(batchId);
}
export async function getImport(id: string) {
  const [batch] = await query("SELECT * FROM import_batches WHERE id=$1", [id]);
  if (!batch) throw new HttpError(404, "NOT_FOUND", "Импорт не найден");
  const stats = await query(
    "SELECT status,count(*)::int count FROM import_rows WHERE batch_id=$1 GROUP BY status",
    [id],
  );
  const rows = await query(
    "SELECT row_number,payload,status,errors,result FROM import_rows WHERE batch_id=$1 ORDER BY row_number LIMIT 100",
    [id],
  );
  return { batch, stats, rows };
}
export async function commitImport(id: string, actor: Actor) {
  await transaction(async (tx) => {
    const [batch] = await tx.query(
      "SELECT * FROM import_batches WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!batch) throw new HttpError(404, "NOT_FOUND", "Импорт не найден");
    if (batch.mode === "historical" && actor.role !== "admin")
      throw new HttpError(403, "FORBIDDEN", "Требуются права администратора");
    if (batch.status !== "validated") return;
    const [current] = await tx.query<{ id: string }>(
      "SELECT id FROM program_versions ORDER BY version DESC LIMIT 1",
    );
    if (current.id !== batch.program_version_id)
      throw new HttpError(
        409,
        "PROGRAM_CHANGED",
        "Настройки изменились. Загрузите файл для повторной проверки.",
      );
    await tx.query(
      "UPDATE import_batches SET status='queued',updated_at=now() WHERE id=$1",
      [id],
    );
    await tx.query(
      "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES($1,$2,'import.commit','import',$3,'Применение проверенных строк','{\"status\":\"queued\"}')",
      [actor.id, actor.role, id],
    );
  });
  await processImportBatch(id, actor);
  return getImport(id);
}
export async function processImportBatch(
  id: string,
  actor: Actor = { id: "import-worker", role: "system" },
  timeBudgetMs = 10000,
) {
  const token = randomUUID(),
    started = Date.now();
  const [batch] = await query<{
    id: string;
    mode: "historical" | "operational";
    program_version_id: string;
    created_by: string;
  }>(
    `UPDATE import_batches SET status='processing',lease_token=$2,lease_until=clock_timestamp()+interval '90 seconds' WHERE id=$1 AND status IN ('queued','processing') AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *`,
    [id, token],
  );
  if (!batch) return;
  const rows = await query<{ id: string; payload: NormalizedRental }>(
    `SELECT id,payload FROM import_rows WHERE batch_id=$1 AND status='valid' ORDER BY COALESCE((payload->>'qualifiedAt')::timestamptz,((payload->>'endDate')||'T23:59:59.999+03:00')::timestamptz),payload->>'externalRentalId' LIMIT 25`,
    [id],
  );
  let processed = 0;
  for (const row of rows) {
    if (Date.now() - started >= timeBudgetMs) break;
    const owned = await query(
      `UPDATE import_batches SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=$1 AND lease_token=$2 RETURNING id`,
      [id, token],
    );
    if (!owned.length) return;
    try {
      const userId = await resolveCustomer(row.payload, "rpm");
      const result = await processRental(
        {
          ...row.payload,
          userId,
          source: "rpm",
          mode: batch.mode,
          programVersionId: batch.program_version_id,
          importBatchId: id,
          idempotencyKey: `import:${id}:${row.id}`,
          reason: "Импорт CSV/XLSX",
        },
        actor,
      );
      await query(
        "UPDATE import_rows SET status=$2,result=$3,rental_id=$4 WHERE id=$1",
        [
          row.id,
          result.status === "duplicate" ? "duplicate" : "processed",
          JSON.stringify(result),
          result.rentalId,
        ],
      );
    } catch (e) {
      if (!(e instanceof Error && "status" in e && Number(e.status) < 500)) {
        await query(
          `UPDATE import_batches SET status='queued',lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2`,
          [id, token],
        );
        throw e;
      }
      await query(
        "UPDATE import_rows SET status='error',errors=$2 WHERE id=$1",
        [row.id, JSON.stringify([e.message])],
      );
    }
    processed++;
  }
  const [remaining] = await query<{ count: number }>(
    "SELECT count(*)::int count FROM import_rows WHERE batch_id=$1 AND status='valid'",
    [id],
  );
  const [errors] = await query<{ count: number }>(
    "SELECT count(*)::int count FROM import_rows WHERE batch_id=$1 AND status IN ('invalid','error')",
    [id],
  );
  await query(
    "UPDATE import_batches SET status=$2,lease_until=NULL,lease_token=NULL,cursor=cursor+$3,updated_at=now() WHERE id=$1 AND lease_token=$4",
    [
      id,
      remaining.count
        ? "queued"
        : errors.count
          ? "completed_with_errors"
          : "completed",
      processed,
      token,
    ],
  );
}
export async function processQueuedImports(limit = 1) {
  const rows = await query<{ id: string }>(
    "SELECT id FROM import_batches WHERE status IN ('queued','processing') AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT $1",
    [limit],
  );
  for (const row of rows) await processImportBatch(row.id);
  return rows.length;
}
