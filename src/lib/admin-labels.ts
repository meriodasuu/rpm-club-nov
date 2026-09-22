const actions: Record<string, string> = {
  "staff.bot_link_login": "Вход по ссылке из бота",
  "staff.login": "Вход сотрудника",
  "staff.logout": "Выход сотрудника",
  "trigger.enable": "Включено автоматическое уведомление",
  "trigger.disable": "Отключено автоматическое уведомление",
  "trigger.update": "Изменены условия уведомления",
  rental: "Зарегистрирована аренда",
  rental_status: "Изменён статус аренды",
  cancel_rental: "Отменена аренда",
  adjust_rental: "Изменена стоимость аренды",
  credit: "Начислены Bonus",
  debit: "Списаны Bonus",
  reverse: "Отменена бонусная операция",
  tier: "Изменён уровень участника",
  publish_program: "Опубликована редакция программы",
  recalculate_tier: "Пересчитан уровень",
  bind_referral: "Привязан код приглашения",
  referral_award: "Начислена награда Bonus",
  referral_reversed: "Отменена награда Bonus",
  "referral_program.publish": "Опубликованы условия приглашений",
  "referral_award.create": "Создана ручная награда",
  "referral_award.issue": "Награда выдана",
  "referral_award.cancel": "Награда обработана при отмене аренды",
};
const events: Record<string, string> = {
  BONUS_CHANGED: "Изменение баланса",
  TIER_CHANGED: "Изменение уровня",
  RPM_DROP: "Предложение клуба",
  BOT_WELCOME: "Приветствие в боте",
  CLUB_TRIGGER: "Автоматическое уведомление",
};
export const actionLabel = (value: string) => actions[value] ?? value;
export const eventLabel = (value: string) => events[value] ?? value;
export const staffRoleLabel = (value: string) =>
  ({
    admin: "Администратор",
    manager: "Менеджер",
    viewer: "Просмотр",
    system: "Система",
    integration: "Интеграция",
  })[value] ?? value;
export const maintenanceStageLabel = (value: string) =>
  ({
    triggers: "Планирование уведомлений",
    bonus_expiration: "Срок действия Bonus",
    referrals: "Награды за приглашения",
    imports: "Импорт",
    program_recalculation: "Пересчёт уровней",
    reconciliation_claim: "Планирование сверки",
    reconciliation: "Сверка операций",
    maintenance_status: "Запись результата",
    unknown: "Этап не установлен",
  })[value] ?? value;
