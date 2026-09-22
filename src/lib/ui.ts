import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export const cn = (...values: ClassValue[]) => twMerge(clsx(values));
export function money(
  value: string | number | bigint | null | undefined,
  kopecks = true,
) {
  const integer = BigInt(value ?? 0);
  if (!kopecks) return integer.toLocaleString("ru-RU");
  const absolute = integer < 0n ? -integer : integer;
  const fraction = absolute % 100n;
  return (integer < 0n ? "-" : "") + (absolute / 100n).toLocaleString("ru-RU") +
    (fraction ? "," + fraction.toString().padStart(2, "0") : "") + " ₽";
}
export function date(value: string | Date | null | undefined) {
  return value
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Europe/Moscow",
      }).format(new Date(value))
    : "—";
}
export function rublesInput(value: string): string {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  const match = normalized.match(/^(\d{1,13})(?:\.(\d{1,2}))?$/);
  if (!match)
    throw new Error(
      "Укажите сумму в рублях, не более двух знаков после запятой",
    );
  return (
    BigInt(match[1]) * 100n +
    BigInt((match[2] ?? "").padEnd(2, "0"))
  ).toString();
}
export const labels: Record<string, string> = {
  active: "Активен",
  pending: "Ожидает активации",
  blocked: "Заблокирован",
  completed: "Завершена",
  accepted: "Принята",
  in_progress: "В аренде",
  cancelled: "Отменена",
  paid: "Оплачена",
  unpaid: "Не оплачена",
  partial: "Частичная оплата",
  refunded: "Возврат",
  rental_cashback: "Bonus за аренду",
  referral_reward: "За приглашение",
  manual_credit: "Начисление Bonus",
  manual_debit: "Корректировка Bonus",
  rental_payment: "Скидка на аренду",
  expiration: "Сгорание Bonus",
  reversal: "Отмена операции",
  rewarded: "Награда начислена",
  bound: "Ожидает аренды",
  qualified: "Условия выполнены",
  reversed: "Отменено",
  ineligible: "Условия не выполнены",
  held: "На проверке",
  issued: "Выпущена",
  unavailable: "Не настроено",
  succeeded: "Доставлено",
  suppressed: "Не отправлено по правилам",
  dead: "Ошибка",
  retry: "Повтор",
  processing: "Обработка",
  queued: "В очереди",
  validated: "Проверен",
  completed_with_errors: "С ошибками",
  valid: "Готова",
  invalid: "Ошибка",
  processed: "Обработана",
  duplicate: "Повтор",
  error: "Ошибка",
};
