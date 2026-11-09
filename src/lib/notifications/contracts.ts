import { z } from "zod";
export const notificationIds = [
  "REG_01",
  "CARD_01",
  "BOOK_01",
  "PAY_01",
  "PAY_02",
  "RIDE_01",
  "RIDE_02",
  "LOY_01",
  "LVL_01",
  "LVL_02",
  "RET_01",
  "APP_01",
  "EXP_01",
  "EXP_02",
  "PROMO_01",
  "BDAY_01",
  "ANNIV_01",
] as const;
export type NotificationId = (typeof notificationIds)[number];
export const blockedNotifications: Partial<Record<NotificationId, string>> = {
  CARD_01: "Карта выдаётся при регистрации; отдельная активация не требуется.",
  PAY_01: "Оплата на месте. Онлайн-оплаты в приложении нет.",
  PAY_02: "Оплата на месте. Онлайн-оплаты в приложении нет.",
};
export function notificationUnavailableReason(
  id: NotificationId,
  rewardMode?: "cashback" | "discount",
) {
  if (blockedNotifications[id]) return blockedNotifications[id];
  if (
    rewardMode === "discount" &&
    ["LOY_01", "EXP_01", "EXP_02", "PROMO_01"].includes(id)
  )
    return "Недоступно при скидочной программе: бонусные сценарии не отправляются.";
}
export const notificationNames: Record<NotificationId, string> = {
  REG_01: "Регистрация не завершена",
  CARD_01: "Карта не активирована",
  BOOK_01: "Заявка не отправлена",
  PAY_01: "Оплата не завершена",
  PAY_02: "Ошибка оплаты",
  RIDE_01: "Первая поездка завершена",
  RIDE_02: "Повторная поездка завершена",
  LOY_01: "Неиспользованные Bonus",
  LVL_01: "Близко к следующему уровню",
  LVL_02: "Новый уровень",
  RET_01: "Перерыв в поездках",
  APP_01: "Вернулся без заявки",
  EXP_01: "Bonus скоро истекают",
  EXP_02: "Bonus истекают завтра",
  PROMO_01: "Промо-начисление",
  BDAY_01: "День рождения",
  ANNIV_01: "Годовщина первой поездки",
};
export const variables = [
  "bonus_balance",
  "bonus_added",
  "bonus_expire_date",
  "loyalty_level",
  "next_level",
  "rides_to_next_level",
  "ride_count",
  "first_name",
  "amount_to_next_level",
  "discount_percent",
] as const;
export function renderNotification(
  template: string,
  values: Record<string, string | number | undefined | null>,
) {
  const fallbacks: Record<string, string> = {
    first_name: "участник клуба",
    next_level: "максимальный уровень",
    loyalty_level: "участник",
    bonus_expire_date: "указанной в профиле даты",
    rides_to_next_level: "—",
  };
  return template.replace(/\{([^{}]+)\}/g, (_, key: string) =>
    String(values[key] ?? fallbacks[key] ?? "0"),
  );
}
const template = z
  .string()
  .trim()
  .min(1)
  .max(1800)
  .refine(
    (t) =>
      [...t.matchAll(/\{([^{}]+)\}/g)].every((m) =>
        (variables as readonly string[]).includes(m[1]),
      ) && !t.replace(/\{[^{}]+\}/g, "").match(/[{}]/),
    "Неизвестная переменная или незакрытые скобки",
  );
export const notificationRuleSchema = z
  .object({
    id: z.enum(notificationIds),
    enabled: z.boolean(),
    title: template,
    body: template,
    imageUrl: z
      .string()
      .regex(/^\/api\/media\/[0-9a-f-]{36}\.webp$/)
      .nullable()
      .optional(),
    cta: z.string().trim().min(1).max(60),
    path: z.enum([
      "/onboarding",
      "/home",
      "/club",
      "/rent",
      "/profile",
      "/history",
    ]),
    category: z.enum(["service", "marketing", "transactional"]),
    delayMinutes: z.number().int().min(0).max(525600),
    cooldownHours: z.number().int().min(0).max(8760),
    priority: z.number().int().min(1).max(100),
    inactivityDays: z.number().int().min(1).max(365),
    minBonus: z.string().regex(/^\d{1,12}$/),
    unusedRides: z.number().int().min(1).max(50),
    nearAmountKopecks: z.string().regex(/^\d{1,15}$/),
    expireHours: z.number().int().min(1).max(8760),
    morningHour: z.number().int().min(0).max(23),
    attributionDays: z.number().int().min(1).max(90),
    expectedVersion: z.number().int().min(0),
  })
  .superRefine((v, ctx) => {
    if (v.imageUrl && v.title.length + v.body.length > 1000)
      ctx.addIssue({
        code: "custom",
        message:
          "Для сообщения с фото заголовок и текст вместе должны быть не длиннее 1000 символов",
      });
    if (v.enabled && blockedNotifications[v.id])
      ctx.addIssue({ code: "custom", message: blockedNotifications[v.id]! });
    if (
      v.body.includes("{rides_to_next_level}") ||
      v.title.includes("{rides_to_next_level}")
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Программа использует оборот. Используйте {amount_to_next_level} вместо числа поездок.",
      });
  });
export type NotificationConfig = z.infer<typeof notificationRuleSchema>;
export interface NotificationRule {
  id: NotificationId;
  config: NotificationConfig;
  version: number;
  enabled_at: string | null;
  updated_at: string;
}
const defaults: Record<
  NotificationId,
  [string, string, string, string, number, number, number]
> = {
  REG_01: [
    "Остался один шаг",
    "Завершите регистрацию, чтобы получить карту и условия клуба.",
    "Завершить регистрацию",
    "/onboarding",
    45,
    24,
    90,
  ],
  CARD_01: [
    "Карта клуба",
    "Карта появляется после регистрации.",
    "Открыть клуб",
    "/club",
    180,
    48,
    80,
  ],
  BOOK_01: [
    "Продолжим планировать поездку?",
    "Ваш выбор сохранён. Проверьте даты и отправьте заявку. Оплата на месте.",
    "Продолжить заявку",
    "/rent",
    30,
    24,
    90,
  ],
  PAY_01: [
    "Оплата на месте",
    "Условия оплаты согласует менеджер.",
    "Открыть заявки",
    "/rent",
    15,
    12,
    100,
  ],
  PAY_02: [
    "Оплата на месте",
    "Свяжитесь с менеджером по вопросам оплаты.",
    "Открыть заявки",
    "/rent",
    10,
    6,
    100,
  ],
  RIDE_01: [
    "Первая поездка состоялась",
    "Спасибо, что выбрали RPM. Посмотрите вашу карту и условия следующих поездок.",
    "Моя карта",
    "/club",
    20,
    0,
    60,
  ],
  RIDE_02: [
    "Спасибо за поездку",
    "Ваша поездка завершена. Актуальные условия и скидка доступны в клубе.",
    "Условия клуба",
    "/club",
    30,
    0,
    60,
  ],
  LOY_01: [
    "У вас остались Bonus",
    "Доступно {bonus_balance} Bonus. Условия использования — в профиле.",
    "Посмотреть баланс",
    "/profile",
    0,
    168,
    40,
  ],
  LVL_01: [
    "До нового уровня совсем близко",
    "До уровня {next_level} осталось {amount_to_next_level} ₽ суммы аренд.",
    "Посмотреть уровень",
    "/club",
    0,
    0,
    65,
  ],
  LVL_02: [
    "Уровень повышен",
    "Теперь у вас уровень {loyalty_level}. Посмотрите ваши привилегии.",
    "Посмотреть привилегии",
    "/club",
    0,
    0,
    70,
  ],
  RET_01: [
    "Давно не виделись",
    "Спланируйте следующую поездку. Ваши условия клуба ждут в приложении.",
    "Выбрать автомобиль",
    "/rent",
    0,
    336,
    30,
  ],
  APP_01: [
    "Вы заглядывали",
    "Если планировали поездку, выберите автомобиль и отправьте заявку.",
    "Открыть автопарк",
    "/rent",
    90,
    168,
    30,
  ],
  EXP_01: [
    "Срок Bonus заканчивается",
    "{bonus_balance} Bonus действуют до {bonus_expire_date}. Проверьте условия использования.",
    "Посмотреть Bonus",
    "/profile",
    0,
    0,
    80,
  ],
  EXP_02: [
    "Bonus скоро истекут",
    "{bonus_balance} Bonus действуют до {bonus_expire_date}.",
    "Посмотреть Bonus",
    "/profile",
    0,
    0,
    85,
  ],
  PROMO_01: [
    "Bonus начислены",
    "Начислено {bonus_added} Bonus. Условия использования доступны в профиле.",
    "Посмотреть баланс",
    "/profile",
    0,
    0,
    65,
  ],
  BDAY_01: [
    "С днём рождения!",
    "{first_name}, желаем приятных поездок. Ваши привилегии — в клубе.",
    "Открыть клуб",
    "/club",
    0,
    0,
    40,
  ],
  ANNIV_01: [
    "Уже год вместе",
    "Спасибо, что ездите с RPM. Посмотрите условия вашей карты.",
    "Открыть клуб",
    "/club",
    0,
    0,
    40,
  ],
};
export function defaultNotification(id: NotificationId): NotificationConfig {
  const [title, body, cta, path, delayMinutes, cooldownHours, priority] =
    defaults[id];
  return {
    id,
    enabled: false,
    title,
    body,
    cta,
    path: path as NotificationConfig["path"],
    category: [
      "REG_01",
      "BOOK_01",
      "RIDE_01",
      "RIDE_02",
      "LVL_02",
      "PROMO_01",
    ].includes(id)
      ? "service"
      : "marketing",
    delayMinutes,
    cooldownHours,
    priority,
    inactivityDays: 21,
    minBonus: "1",
    unusedRides: 2,
    nearAmountKopecks: "0",
    expireHours: id === "EXP_02" ? 24 : 168,
    morningHour: 10,
    attributionDays: 7,
    expectedVersion: 0,
  };
}
