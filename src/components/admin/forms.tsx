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
  | "payment"
  | "complete"
  | "pickup"
  | "credit"
  | "debit"
  | "redeem"
  | "reverse"
  | "cancel"
  | "adjust"
  | "turnoverCredit"
  | "turnoverDebit"
  | "tier"
  | "block"
  | "restore";
const titles: Record<FinanceAction, string> = {
  rental: "Добавить аренду",
  status: "Статус аренды",
  payment: "Оплата аренды",
  complete: "Завершить поездку",
  pickup: "Время выдачи автомобиля",
  credit: "Начислить Bonus",
  debit: "Списать Bonus",
  redeem: "Применить Bonus к аренде",
  reverse: "Отменить бонусную операцию",
  cancel: "Отменить аренду",
  adjust: "Скорректировать аренду",
  turnoverCredit: "Пополнить сумму аренд",
  turnoverDebit: "Списать сумму аренд",
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
    [error, setError] = useState(""),
    [selectedUserId, setSelectedUserId] = useState(userId ?? "");
  const [key] = useState(() => crypto.randomUUID());
  const [defaultCompletionAt] = useState(() =>
    new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 16),
  );
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
          externalRentalId: "manual:" + key,
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
      } else if (["status", "payment", "complete"].includes(action)) {
        url = `admin/rentals/${entityId}/status`;
        data = {
          ...data,
          status:
            action === "complete"
              ? "completed"
              : action === "payment"
                ? rental?.status
                : value("status"),
          paymentStatus: action === "payment" ? "paid" : value("paymentStatus"),
          expectedVersion: rental?.version,
          ...(action === "complete"
            ? {
                completedAt: new Date(
                  value("completedAt") + ":00+03:00",
                ).toISOString(),
              }
            : {}),
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
      } else if (["turnoverCredit", "turnoverDebit"].includes(action)) {
        url = `admin/customers/${uid}/rental-turnover`;
        data = {
          ...data,
          operation: action === "turnoverCredit" ? "credit" : "debit",
          amountKopecks: rublesInput(value("amount")),
        };
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
    "turnoverCredit",
    "turnoverDebit",
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
            <CustomerPicker
              onSelect={(customer) =>
                setSelectedUserId(String(customer?.id ?? ""))
              }
            />
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
        {(action === "rental" ||
          action === "status" ||
          action === "complete") && (
          <>
            {action !== "complete" && (
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
            )}
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
        {action === "complete" && (
          <Field label="Фактическое завершение (Москва)">
            <input
              name="completedAt"
              type="datetime-local"
              required
              defaultValue={defaultCompletionAt}
            />
          </Field>
        )}
        {action === "payment" && (
          <p className="small-note">
            Подтвердите получение полной оплаты аренды.
          </p>
        )}
        {needsAmount && (
          <Field
            label={
              action === "rental" || action === "adjust" || action === "turnoverCredit" || action === "turnoverDebit"
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
        {action === "redeem" && selectedUserId && (
          <RentalPriceField key={selectedUserId} userId={selectedUserId} />
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

function RentalPriceField({ userId }: { userId: string }) {
  const [selected, setSelected] = useState<Row | null>(null);
  const r = useResource<{ rentals: { items: Row[] } }>(
    `admin/customers/${userId}`,
  );
  const rentals = (r.data?.rentals.items ?? []).filter(
    (item) => item.mode === "operational" && item.status !== "cancelled",
  );
  return (
    <>
      <Field
        label="Аренда"
        hint="Выберите поездку участника. ID привяжется автоматически."
      >
        <select
          name="externalRentalId"
          required
          value={String(selected?.external_rental_id ?? "")}
          onChange={(event) =>
            setSelected(
              rentals.find(
                (item) => item.external_rental_id === event.target.value,
              ) ?? null,
            )
          }
        >
          <option value="" disabled>
            {r.loading ? "Загружаем аренды…" : "Выберите аренду"}
          </option>
          {rentals.map((item) => (
            <option
              key={String(item.external_rental_id)}
              value={String(item.external_rental_id)}
            >
              {String(item.car_name)} · {date(String(item.start_date))} ·{" "}
              {money(
                String(item.current_amount_kopecks ?? item.amount_kopecks),
              )}
            </option>
          ))}
        </select>
      </Field>
      <input
        type="hidden"
        name="eligiblePrice"
        value={String(
          selected?.current_amount_kopecks ?? selected?.amount_kopecks ?? "",
        )}
        required
      />
      <Field label="Стоимость аренды до скидки Bonus, ₽">
        <input
          value={
            selected
              ? String(
                  Number(
                    selected.current_amount_kopecks ?? selected.amount_kopecks,
                  ) / 100,
                )
              : ""
          }
          readOnly
          placeholder="Заполнится после выбора аренды"
        />
      </Field>
      {r.error && <FormMessage error={r.error.message} />}
      {!r.loading && !r.error && !rentals.length && (
        <p className="small-note">
          Нет подходящих текущих аренд. Сначала добавьте аренду в клуб.
        </p>
      )}
    </>
  );
}
