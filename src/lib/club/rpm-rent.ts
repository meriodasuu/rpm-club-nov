import { z } from "zod";
import { query, transaction, type Db } from "@/lib/db";
import { createRequestedRental, updateRentalStatus } from "@/lib/loyalty";
import { type RentalRequest } from "./contracts";

const amount = z.string().regex(/^\d{1,15}$/);
export const rentPayload = z.object({
  requestId: z.string().uuid(),
  carId: z.string().min(1).max(200),
  carTitle: z.string().min(1).max(160),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.number().int().min(1).max(90),
  grossKopecks: amount,
  discountKopecks: amount,
  totalKopecks: amount,
  discountBps: z.number().int().min(0).max(9999),
  customerName: z.string().min(1).max(200),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
  telegram: z.string().nullable(),
  comment: z.string().max(1000),
  createdAt: z.string(),
  privacyConsentAt: z.string().nullable(),
});
type Payload = z.infer<typeof rentPayload>;
const peerState = z.object({
  id: z.string(),
  number: z.number().int(),
  status: z.enum([
    "NEW",
    "IN_PROGRESS",
    "CONFIRMED",
    "COMPLETED",
    "DECLINED",
    "CANCELLED",
  ]),
  note: z.string().nullable(),
});
type PeerState = z.infer<typeof peerState>;
const actor = { id: "rpm-rent-requests", role: "system" as const };

export function bridgeMessage(p: Payload, number: number, status: string) {
  const rubles = (value: string) => {
    const kopecks = BigInt(value);
    return (
      (kopecks / 100n).toLocaleString("ru-RU") +
      (kopecks % 100n
        ? "," + (kopecks % 100n).toString().padStart(2, "0")
        : "") +
      " ₽"
    );
  };
  return [
    "🚗 Новая заявка · Из RPM Club",
    `Заявка #${number}`,
    `Автомобиль: ${p.carTitle}`,
    `Даты: ${p.startDate} — ${p.endDate} (${p.days} сут.)`,
    `Клиент: ${p.customerName}`,
    `Телефон: ${p.phone}`,
    `Telegram: ${p.telegram || "не указан"}`,
    `Стоимость аренды: ${rubles(p.grossKopecks)}`,
    `Скидка по карте ${p.discountBps / 100}%: ${rubles(p.discountKopecks)}`,
    `К оплате: ${rubles(p.totalKopecks)}`,
    `Комментарий: ${p.comment || "нет"}`,
    status === "DECLINED"
      ? "Даты или автомобиль недоступны — требуется предложить другой вариант."
      : "Оплата на месте.",
    `Подробнее: /booking ${number}`,
  ].join("\n");
}

async function applyPeer(requestId: string, state: PeerState) {
  const [existing] = await query<RentalRequest>(
    "SELECT * FROM rental_requests WHERE id=$1 AND rpm_rent_managed",
    [requestId],
  );
  if (!existing) return;
  if (["CANCELLED", "DECLINED"].includes(state.status) && existing.rental_id) {
    const [rental] = await query<{
      status: string;
      payment_status: "paid" | "unpaid" | "partial" | "refunded";
      version: number;
    }>("SELECT status,payment_status,version FROM rentals WHERE id=$1", [
      existing.rental_id,
    ]);
    if (rental && rental.status !== "cancelled")
      await updateRentalStatus(
        {
          rentalId: existing.rental_id,
          status: "cancelled",
          paymentStatus: rental.payment_status,
          expectedVersion: rental.version,
          reason: "Отмена заявки RPM Rent",
          idempotencyKey: `rpm-rent-cancel:${requestId}`,
        },
        actor,
      );
  }
  await transaction(async (tx) => {
    const [row] = await tx.query<RentalRequest>(
      "SELECT *,to_char(start_date,'YYYY-MM-DD') start_date,to_char(end_date,'YYYY-MM-DD') end_date FROM rental_requests WHERE id=$1 FOR UPDATE",
      [requestId],
    );
    if (!row) return;
    let rentalId = row.rental_id;
    if (["CONFIRMED", "COMPLETED"].includes(state.status) && !rentalId) {
      const rental = await createRequestedRental(
        tx,
        {
          userId: row.user_id,
          externalRentalId: "app:" + row.id,
          carName: row.car_name,
          startDate: row.start_date,
          endDate: row.end_date,
          amountKopecks: row.total_kopecks,
          idempotencyKey: "request:" + row.id,
          reason: "Подтверждена в RPM Rent; оплата ещё не отмечена",
        },
        actor,
      );
      rentalId = rental.rentalId;
    }
    const status =
      row.status === "cancelled" &&
      ["NEW", "IN_PROGRESS"].includes(state.status)
        ? "cancelled"
        : state.status === "DECLINED"
          ? "declined"
          : state.status === "CANCELLED"
            ? "cancelled"
            : ["CONFIRMED", "COMPLETED"].includes(state.status)
              ? "accepted"
              : "pending";
    await tx.query(
      "UPDATE rental_requests SET rpm_rent_id=$2,rpm_rent_number=$3,rpm_rent_status=$4,rpm_rent_sync_error=NULL,status=$5,staff_note=coalesce($6,''),rental_id=$7,updated_at=now() WHERE id=$1",
      [
        requestId,
        state.id,
        state.number,
        state.status,
        status,
        state.note,
        rentalId,
      ],
    );
  });
}

export async function exportRentRequests(peer: Db) {
  const exports = await query<{
    request_id: string;
    payload: unknown;
    status: string;
  }>(
    "SELECT e.request_id,e.payload,r.status FROM rpm_rent_exports e JOIN rental_requests r ON r.id=e.request_id WHERE e.exported_at IS NULL AND e.next_attempt_at<=now() ORDER BY e.created_at LIMIT 5",
  );
  for (const job of exports) {
    try {
      const payload = rentPayload.parse(job.payload);
      // Retrying receive is safe even after a crash between the two database commits.
      const [received] = await peer.query<{ result: unknown }>(
        "SELECT rpm_club_requests.receive($1::jsonb) result",
        [JSON.stringify(payload)],
      );
      const state = peerState.parse(received.result);
      if (job.status === "cancelled") {
        await peer.query("SELECT rpm_club_requests.cancel($1::uuid)", [
          job.request_id,
        ]);
        const [cancelled] = await peer.query<PeerState>(
          "SELECT id,number,status,note FROM rpm_club_requests.bookings WHERE request_id=$1",
          [job.request_id],
        );
        await applyPeer(job.request_id, peerState.parse(cancelled));
      } else await applyPeer(job.request_id, state);
      await query(
        "UPDATE rpm_rent_exports SET exported_at=now(),attempts=attempts+1 WHERE request_id=$1",
        [job.request_id],
      );
    } catch {
      await query(
        "UPDATE rpm_rent_exports SET attempts=attempts+1,next_attempt_at=now()+least(300,power(2,least(attempts+1,8))) * interval '1 second' WHERE request_id=$1",
        [job.request_id],
      );
      await query(
        "UPDATE rental_requests SET rpm_rent_sync_error='Не удалось передать заявку в RPM Rent. Повторяем автоматически.' WHERE id=$1",
        [job.request_id],
      );
    }
  }
}

export async function syncRentStates(peer: Db) {
  const requests = await query<{
    id: string;
    status: string;
    rpm_rent_status: string;
  }>(
    "SELECT r.id,r.status,r.rpm_rent_status FROM rental_requests r JOIN rpm_rent_exports e ON e.request_id=r.id WHERE e.exported_at IS NOT NULL AND r.rpm_rent_id IS NOT NULL AND (r.rpm_rent_status NOT IN ('CANCELLED','DECLINED','COMPLETED') OR r.rpm_rent_sync_error IS NOT NULL) ORDER BY r.updated_at LIMIT 200",
  );
  if (!requests.length) return;
  for (const row of requests)
    if (
      row.status === "cancelled" &&
      !["CANCELLED", "DECLINED"].includes(row.rpm_rent_status)
    )
      await peer.query("SELECT rpm_club_requests.cancel($1::uuid)", [row.id]);
  const states = await peer.query<PeerState & { request_id: string }>(
    "SELECT id,number,status,note,request_id FROM rpm_club_requests.bookings WHERE request_id=ANY($1::text[])",
    [requests.map((r) => r.id)],
  );
  for (const state of states) {
    try {
      await applyPeer(state.request_id, peerState.parse(state));
    } catch {
      await query(
        "UPDATE rental_requests SET rpm_rent_sync_error='Статус RPM Rent получен, но не применён. Повторяем автоматически.',updated_at=now() WHERE id=$1",
        [state.request_id],
      );
    }
  }
}

export type SendRentMessage = (
  chatId: string,
  text: string,
  number: number,
) => Promise<number>;
export async function deliverRentNotifications(
  peer: Db,
  send: SendRentMessage,
) {
  const recipients = await peer.query<{ chat_id: string }>(
    "SELECT chat_id FROM rpm_club_requests.recipients",
  );
  const ids = recipients.map((r) => r.chat_id);
  if (!ids.length) return;
  await query(
    `INSERT INTO rpm_rent_deliveries(request_id,chat_id) SELECT e.request_id,c.chat_id FROM rpm_rent_exports e JOIN rental_requests r ON r.id=e.request_id CROSS JOIN unnest($1::text[]) c(chat_id) WHERE e.exported_at IS NOT NULL AND r.rpm_rent_id IS NOT NULL AND r.status<>'cancelled' AND NOT EXISTS(SELECT 1 FROM rpm_rent_deliveries d WHERE d.request_id=e.request_id) ON CONFLICT DO NOTHING`,
    [ids],
  );
  const deliveries = await query<{
    request_id: string;
    chat_id: string;
    payload: unknown;
    rpm_rent_number: number;
    rpm_rent_status: string;
  }>(
    "SELECT d.request_id,d.chat_id,e.payload,r.rpm_rent_number,r.rpm_rent_status FROM rpm_rent_deliveries d JOIN rpm_rent_exports e ON e.request_id=d.request_id JOIN rental_requests r ON r.id=e.request_id WHERE d.delivered_at IS NULL AND d.next_attempt_at<=now() AND d.chat_id=ANY($1::text[]) AND r.status<>'cancelled' ORDER BY e.created_at LIMIT 5",
    [ids],
  );
  for (const job of deliveries) {
    try {
      const messageId = await send(
        job.chat_id,
        bridgeMessage(
          rentPayload.parse(job.payload),
          job.rpm_rent_number,
          job.rpm_rent_status,
        ),
        job.rpm_rent_number,
      );
      await query(
        "UPDATE rpm_rent_deliveries SET delivered_at=now(),message_id=$3,attempts=attempts+1 WHERE request_id=$1 AND chat_id=$2",
        [job.request_id, job.chat_id, messageId],
      );
    } catch {
      await query(
        "UPDATE rpm_rent_deliveries SET attempts=attempts+1,next_attempt_at=now()+least(3600,30*power(2,least(attempts,7))) * interval '1 second' WHERE request_id=$1 AND chat_id=$2",
        [job.request_id, job.chat_id],
      );
    }
  }
}
