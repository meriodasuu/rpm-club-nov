"use client";
import { useState, type FormEvent } from "react";
import {
  Dialog,
  Field,
  FormMessage,
  Spinner,
  command,
  useResource,
} from "@/components/shared";
import { CustomerPicker, CarNameField } from "./customer-picker";
import { DialogClose } from "@/components/shared";
import { date, money, labels, rublesInput } from "@/lib/ui";
import type { Row } from "./tables";
import type { Program } from "@/lib/loyalty/types";
import { tierName } from "@/lib/loyalty/rules";
export type FinanceAction =
  | "rental"
  | "status"
  | "pickup"
  | "credit"
  | "debit"
  | "redeem"
  | "reverse"
  | "cancel"
  | "adjust"
  | "tier"
  | "block"
  | "restore";
const titles: Record<FinanceAction, string> = {
  rental: "Добавить аренду",
  status: "Статус аренды",
  pickup: "Время выдачи автомобиля",
  credit: "Начислить Bonus",
  debit: "Списать Bonus",
  redeem: "Применить Bonus к аренде",
  reverse: "Отменить бонусную операцию",
  cancel: "Отменить аренду",
  adjust: "Скорректировать аренду",
  tier: "Изменить уровень",
  block: "Заблокировать участника",
  restore: "Восстановить доступ",
};
export function FinanceDialog({
  action,
  userId,
  entityId,
  rental,
  onClose,
  onDone,
}: {
  action: FinanceAction;
  userId?: string;
  entityId?: string;
  rental?: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: program, error: programError } =
    useResource<Program>("admin/tiers");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(event.currentTarget),
      value = (name: string) => String(f.get(name) ?? "");
    try {
      const uid = userId ?? value("userId");
      const reason = value("reason");
      let url = "",
        data: Record<string, unknown> = { reason };
      if (action === "rental") {
        url = "admin/rentals";
        data = {
          ...data,
          userId: uid,
          externalRentalId: value("externalRentalId"),
          carName: value("carName"),
          startDate: value("startDate"),
          endDate: value("endDate"),
          ...(value("pickupTime")
            ? {
                pickupAt: new Date(
                  value("startDate") + "T" + value("pickupTime") + ":00+03:00",
                ).toISOString(),
              }
            : {}),
          amountKopecks: rublesInput(value("amount")),
          status: value("status"),
          paymentStatus: value("paymentStatus"),
        };
      } else if (action === "pickup") {
        url = `admin/rentals/${entityId}/pickup`;
        const day = String(rental?.start_date).slice(0, 10);
        data = {
          ...data,
          pickupAt: new Date(
            day + "T" + value("pickupTime") + ":00+03:00",
          ).toISOString(),
          expectedVersion: rental?.version,
        };
      } else if (action === "status") {
        url = `admin/rentals/${entityId}/status`;
        data = {
          ...data,
          status: value("status"),
          paymentStatus: value("paymentStatus"),
          expectedVersion: rental?.version,
        };
      } else if (["credit", "debit", "redeem"].includes(action)) {
        url = "admin/bonus/" + action;
        data = { ...data, userId: uid, amount: value("amount") };
        if (action === "redeem")
          data = {
            ...data,
            externalRentalId: value("externalRentalId"),
            eligiblePriceKopecks: rublesInput(value("eligiblePrice")),
          };
        if (action === "credit" && value("expiresAt"))
          data.expiresAt = new Date(value("expiresAt")).toISOString();
      } else if (action === "reverse") {
        url = "admin/bonus/reverse";
        data.transactionId = entityId;
      } else if (action === "cancel" || action === "adjust") {
        url = `admin/rentals/${entityId}/${action}`;
        if (action === "adjust")
          data.amountKopecks = rublesInput(value("amount"));
      } else {
        url = `admin/customers/${uid}/${action}`;
        if (action === "tier") data.tier = value("tier") || null;
      }
      await command(url, data, "POST", key);
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const needsAmount = [
    "rental",
    "credit",
    "debit",
    "redeem",
    "adjust",
  ].includes(action);
  return (
    <Dialog title={titles[action]} onClose={onClose} protectChanges busy={busy}>
      <form className="form-stack" onSubmit={submit}>
        {rental && (
          <div className="panel panel-body">
            <strong>
              {String(rental.customer_name ?? "Участник")} ·{" "}
              {String(rental.car_name ?? "Аренда")}
            </strong>
            <p>
              {date(String(rental.start_date))} —{" "}
              {date(String(rental.end_date))}
            </p>
            <p>
              {money(
                String(rental.current_amount_kopecks ?? rental.amount_kopecks),
              )}{" "}
              ·{" "}
              {labels[String(rental.payment_status)] ??
                String(rental.payment_status)}
            </p>
          </div>
        )}
        {!userId &&
          ["rental", "credit", "debit", "redeem"].includes(action) && (
            <CustomerPicker />
          )}
        {(action === "rental" || action === "redeem") && (
          <Field
            label="Внешний ID аренды"
            hint="ID из системы бронирования RPM. Один и тот же ID защищает от повторного создания аренды."
          >
            <input name="externalRentalId" required maxLength={128} />
          </Field>
        )}
        {action === "rental" && (
          <>
            <CarNameField />
            <div className="form-grid">
              <Field label="Начало">
                <input name="startDate" type="date" required />
              </Field>
              <Field label="Завершение">
                <input name="endDate" type="date" required />
              </Field>
            </div>
          </>
        )}
        {(action === "rental" || action === "pickup") && (
          <Field
            label="Время выдачи (Москва)"
            hint="Напоминание отправится за 2 часа до согласованного времени выдачи. Без времени напоминание не отправляется."
          >
            <input
              name="pickupTime"
              type="time"
              required={action === "pickup"}
              defaultValue={
                rental?.pickup_at
                  ? new Date(String(rental.pickup_at)).toLocaleTimeString(
                      "ru-RU",
                      {
                        timeZone: "Europe/Moscow",
                        hour: "2-digit",
                        minute: "2-digit",
                      },
                    )
                  : ""
              }
            />
          </Field>
        )}
        {(action === "rental" || action === "status") && (
          <>
            <Field label="Статус аренды">
              <select
                name="status"
                defaultValue={String(rental?.status ?? "accepted")}
              >
                <option value="accepted">Принята</option>
                <option value="in_progress">В аренде</option>
                <option value="completed">Завершена</option>
                {action === "status" && (
                  <option value="cancelled">Отменена</option>
                )}
              </select>
            </Field>
            <Field label="Оплата">
              <select
                name="paymentStatus"
                defaultValue={String(rental?.payment_status ?? "unpaid")}
              >
                <option value="unpaid">Не оплачена</option>
                <option value="partial">Частично оплачена</option>
                <option value="paid">Полностью оплачена</option>
                {action === "status" && (
                  <option value="refunded">
                    Возвращена (только с отменой)
                  </option>
                )}
              </select>
            </Field>
            <p className="small-note">
              Прогресс уровня обновится после завершения и полной оплаты.
              Начисление Bonus зависит от действующей механики программы.
            </p>
          </>
        )}
        {needsAmount && (
          <Field
            label={
              action === "rental" || action === "adjust"
                ? "Стоимость аренды, ₽"
                : "Количество Bonus"
            }
            hint={
              action === "rental"
                ? "Только аренда после скидок. Без залога, штрафов и доплат."
                : undefined
            }
          >
            <input
              name="amount"
              inputMode="decimal"
              required
              pattern={
                action === "rental" || action === "adjust"
                  ? "[0-9]+([.,][0-9]{1,2})?"
                  : "[0-9]+"
              }
            />
          </Field>
        )}
        {action === "redeem" && (
          <Field label="Стоимость аренды до скидки Bonus, ₽">
            <input name="eligiblePrice" inputMode="decimal" required />
          </Field>
        )}
        {action === "credit" && (
          <Field label="Срок действия (необязательно)">
            <input name="expiresAt" type="datetime-local" />
          </Field>
        )}
        {action === "tier" && (
          <Field label="Уровень">
            <select name="tier">
              <option value="">Снять ручную пометку</option>
              {program?.tiers.map((t) => (
                <option key={t.code} value={t.code}>
                  {tierName(t)}
                </option>
              ))}
            </select>
            <small>
              {!program && !programError
                ? "Загружаем опубликованные уровни…"
                : "Достигнутый статус не понизится."}
            </small>
          </Field>
        )}
        {["cancel", "reverse"].includes(action) && (
          <p className="small-note">
            Изменение будет отражено отдельными компенсирующими операциями.
            История сохранится.
          </p>
        )}
        <Field label="Причина">
          <textarea
            name="reason"
            required
            minLength={3}
            maxLength={1000}
            placeholder="Основание операции"
          />
        </Field>
        <FormMessage
          error={
            error || (action === "tier" ? programError?.message : undefined)
          }
        />
        <div className="form-actions">
          <DialogClose disabled={busy}>Отмена</DialogClose>
          <button
            className="button"
            disabled={busy || (action === "tier" && !program)}
          >
            {busy ? <Spinner /> : null}
            {action === "status" ? "Сохранить статус" : "Подтвердить"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
