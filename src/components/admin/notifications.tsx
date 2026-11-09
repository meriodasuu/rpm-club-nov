"use client";
import { useState } from "react";
import {
  Field,
  FormMessage,
  Loading,
  Failure,
  useResource,
  command,
} from "@/components/shared";
import {
  notificationNames,
  notificationUnavailableReason,
  renderNotification,
  variables,
  type NotificationRule,
  type NotificationConfig,
  type NotificationId,
} from "@/lib/notifications/contracts";
import { useUnsavedChanges } from "./unsaved";
import { ImageUpload } from "./image-upload";
import { DataTable, type Row } from "./tables";
import { date } from "@/lib/ui";
const notificationPurpose: Partial<Record<NotificationRule["id"], string>> = {
  REG_01: "Напоминание, если регистрация не завершена",
  BOOK_01: "Напоминание о незавершённой заявке",
  RIDE_01: "После первой завершённой поездки",
  RIDE_02: "После следующих завершённых поездок",
  LVL_01: "Когда участник близок к новому уровню",
  LVL_02: "Когда участник получил новый уровень",
  RET_01: "После долгого перерыва в поездках",
  APP_01: "После возвращения в приложение без заявки",
  BDAY_01: "Поздравление в день рождения",
  ANNIV_01: "Поздравление в годовщину первой поездки",
};
function notificationTiming(rule: NotificationRule) {
  if (["BDAY_01", "ANNIV_01"].includes(rule.id))
    return `В ${String(rule.config.morningHour).padStart(2, "0")}:00 по Москве`;
  if (rule.id === "RET_01")
    return `После ${rule.config.inactivityDays} дней без поездок`;
  if (rule.config.delayMinutes === 0) return "Сразу после события";
  if (rule.config.delayMinutes < 60)
    return `Через ${rule.config.delayMinutes} мин после события`;
  const hours = Math.floor(rule.config.delayMinutes / 60);
  const minutes = rule.config.delayMinutes % 60;
  return `Через ${hours} ч${minutes ? ` ${minutes} мин` : ""} после события`;
}
export function LifecycleNotifications() {
  const r = useResource<{
    rewardMode: "cashback" | "discount";
    rules: NotificationRule[];
    stats: Row[];
    logs: Row[];
    limits: { service: number; marketing: number };
  }>("admin/notifications");
  const [error, setError] = useState("");
  const [savingLimits, setSavingLimits] = useState(false);
  const available =
    r.data?.rules.filter(
      (rule) => !notificationUnavailableReason(rule.id, r.data!.rewardMode),
    ) ?? [];
  const unavailable =
    r.data?.rules.filter((rule) =>
      notificationUnavailableReason(rule.id, r.data!.rewardMode),
    ) ?? [];
  const enabledCount = available.filter((rule) => rule.config.enabled).length;
  return (
    <section>
      <h2>Сообщения участникам</h2>
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : (
        <>
          <div className="panel panel-body">
            <h3>
              {enabledCount} из {available.length} сценариев включено
            </h3>
            <p>
              Чтобы изменить отправку, нажмите «Включить» или «Выключить» рядом
              со сценарием. Текст и условия находятся в его настройках.
            </p>
            <p className="small-note">
              Новые события обрабатываются после включения. Старые события не
              отправляются повторно. День рождения и годовщина — поздравления
              без автоматического подарка.
            </p>
          </div>
          <details className="panel">
            <summary className="panel-header">Суточные ограничения</summary>
            <div className="panel-body">
              <h3>Лимит на участника в сутки · Москва</h3>
              <p>
                Можно разрешить до одного сервисного и одного маркетингового
                сообщения в сутки. Транзакционные сообщения не ограничиваются.
              </p>
              <div className="form-grid">
                {(["service", "marketing"] as const).map((key) => (
                  <Field
                    key={key}
                    label={key === "service" ? "Сервисные" : "Маркетинговые"}
                  >
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={r.data!.limits[key] === 1}
                        disabled={savingLimits}
                        onChange={async (e) => {
                          setSavingLimits(true);
                          setError("");
                          try {
                            await command("admin/notification-limits", {
                              ...r.data!.limits,
                              [key]: e.target.checked ? 1 : 0,
                            });
                            await r.refresh();
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setSavingLimits(false);
                          }
                        }}
                      />
                      Разрешить
                    </label>
                  </Field>
                ))}
              </div>
              <FormMessage error={error} />
            </div>
          </details>
          {available.map((rule) => (
            <NotificationEditor
              key={rule.id + ":" + rule.version}
              rule={rule}
              rewardMode={r.data!.rewardMode}
              onDone={r.refresh}
            />
          ))}
          {unavailable.length > 0 && (
            <details className="panel">
              <summary className="panel-header">
                Недоступные сценарии ({unavailable.length})
              </summary>
              <div className="panel-body">
                {unavailable.map((rule) => (
                  <p key={rule.id}>
                    <strong>{notificationNames[rule.id]}</strong> —{" "}
                    {notificationUnavailableReason(rule.id, r.data!.rewardMode)}
                  </p>
                ))}
              </div>
            </details>
          )}
          <details className="panel">
            <summary className="panel-header">
              Статистика и журнал отправок
            </summary>
            <div className="panel-body">
              <h3>Результаты по сценарию</h3>
              <p className="small-note">
                «Отправлено» — Telegram принял запрос. Доставка на устройство и
                прочтение ботом не подтверждаются. «Открыто» — участник открыл
                целевой экран по ссылке. Конверсия — целевое действие в заданном
                окне после отправки; для просмотра карты это открытие экрана.
              </p>
              <DataTable
                headings={[
                  "ID",
                  "Отправлено",
                  "Открыто",
                  "Целевое действие",
                  "Конверсия",
                  "Отменено",
                ]}
                rows={r.data.stats}
                render={(s) => (
                  <>
                    <td>
                      {notificationNames[
                        String(s.trigger_id) as NotificationId
                      ] ?? String(s.trigger_id)}
                    </td>
                    <td>{String(s.sent)}</td>
                    <td>{String(s.opened)}</td>
                    <td>{String(s.converted)}</td>
                    <td>
                      {Number(s.sent)
                        ? (
                            (100 * Number(s.converted)) /
                            Number(s.sent)
                          ).toFixed(1) + "%"
                        : "—"}
                    </td>
                    <td>{String(s.cancelled)}</td>
                  </>
                )}
              />
              <h3>Последние 100 событий</h3>
              <DataTable
                headings={[
                  "Сценарий / получатель",
                  "Состояние",
                  "Назначено",
                  "Отправлено",
                  "Причина",
                  "Экран",
                ]}
                rows={r.data.logs}
                render={(s) => (
                  <>
                    <td>
                      {notificationNames[
                        String(s.trigger_id) as NotificationId
                      ] ?? String(s.trigger_id)}
                      <small>{String(s.name ?? "Регистрация")}</small>
                    </td>
                    <td>
                      {{
                        pending: "Ожидает",
                        sending: "Отправляется",
                        sent: "Отправлено",
                        cancelled: "Отменено",
                        failed: "Ошибка",
                      }[String(s.status)] ?? String(s.status)}
                    </td>
                    <td>{date(String(s.scheduled_at))}</td>
                    <td>{s.sent_at ? date(String(s.sent_at)) : "—"}</td>
                    <td>
                      {(
                        {
                          TRIGGER_DISABLED: "Сценарий выключен",
                          RULE_UPDATED: "Настройки изменены",
                          EXPIRED: "Срок прошёл",
                          CONDITION_COMPLETED_OR_CHANGED:
                            "Действие выполнено или условие изменилось",
                          MEMBER_UNAVAILABLE: "Участник недоступен",
                          NOTIFICATIONS_DISABLED:
                            "Уведомления отключены участником",
                          MARKETING_OPT_OUT: "Нет согласия на маркетинг",
                          CHANNEL_UNAVAILABLE: "Telegram недоступен",
                          DAILY_LIMIT: "Суточный лимит",
                          COOLDOWN: "Слишком скоро после предыдущего сообщения",
                          ATTEMPTS_EXHAUSTED: "Попытки исчерпаны",
                          SEND_FAILED: "Ошибка отправки",
                          "telegram:403": "Бот заблокирован",
                          "telegram:429": "Ограничение Telegram",
                          "telegram:503": "Telegram временно недоступен",
                        } as Record<string, string>
                      )[String(s.reason)] ?? String(s.reason ?? "—")}
                    </td>
                    <td>{String(s.path)}</td>
                  </>
                )}
              />
            </div>
          </details>
        </>
      )}
    </section>
  );
}
function NotificationEditor({
  rule,
  rewardMode,
  onDone,
}: {
  rule: NotificationRule;
  rewardMode: "cashback" | "discount";
  onDone: () => Promise<void>;
}) {
  const [config, setConfig] = useState<NotificationConfig>({
      ...rule.config,
      expectedVersion: rule.version,
    }),
    [busy, setBusy] = useState(false),
    [imageBusy, setImageBusy] = useState(false),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false);
  const guard = useUnsavedChanges();
  const set = <K extends keyof NotificationConfig>(
    key: K,
    value: NotificationConfig[K],
  ) => {
    guard.markDirty();
    setDirty(true);
    setConfig((c) => ({ ...c, [key]: value }));
  };
  const blocked = notificationUnavailableReason(rule.id, rewardMode);
  const [toggleBusy, setToggleBusy] = useState(false);
  return (
    <article className="panel">
      <div className="panel-header">
        <div>
          <h3>{notificationNames[rule.id]}</h3>
          <span className="small-note">
            {config.enabled ? "Включено" : "Выключено"} ·{" "}
            {notificationPurpose[rule.id] ?? rule.id} ·{" "}
            {notificationTiming(rule)}
          </span>
        </div>
        {!blocked && (
          <button
            type="button"
            className={config.enabled ? "button button-outline" : "button"}
            disabled={busy || toggleBusy}
            onClick={async () => {
              if (dirty) {
                setError("Сначала сохраните изменения в настройках сценария.");
                return;
              }
              setToggleBusy(true);
              setError("");
              try {
                await command("admin/notifications", {
                  ...rule.config,
                  enabled: !rule.config.enabled,
                  expectedVersion: rule.version,
                });
                await onDone();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setToggleBusy(false);
              }
            }}
          >
            {toggleBusy
              ? "Сохраняем…"
              : config.enabled
                ? "Выключить"
                : "Включить"}
          </button>
        )}
      </div>
      <details>
        <summary className="panel-body">Изменить текст и условия</summary>
        <form
          className="panel-body form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await command("admin/notifications", config);
              guard.markSaved();
              await onDone();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {blocked ? (
            <p>{blocked}</p>
          ) : (
            <>
              <Field label="Заголовок">
                <input
                  value={config.title}
                  maxLength={1800}
                  disabled={busy}
                  onChange={(e) => set("title", e.target.value)}
                  required
                />
              </Field>
              <Field label="Текст">
                <textarea
                  value={config.body}
                  maxLength={1800}
                  rows={3}
                  disabled={busy}
                  onChange={(e) => set("body", e.target.value)}
                  required
                />
              </Field>
              <div className="form-stack">
                <strong>Фото к уведомлению</strong>
                <p className="small-note">
                  Фото появится над текстом в Telegram.
                </p>
                <ImageUpload
                  value={config.imageUrl ?? ""}
                  onChange={(value) => set("imageUrl", value || null)}
                  busy={imageBusy}
                  onBusy={setImageBusy}
                  allowUrl={false}
                />
                {config.imageUrl && (
                  <button
                    type="button"
                    className="button button-outline"
                    disabled={imageBusy || busy}
                    onClick={() => set("imageUrl", null)}
                  >
                    Удалить фото
                  </button>
                )}
              </div>
              {config.imageUrl && (
                <p className="small-note">
                  С фото заголовок и текст вместе — до 1000 символов.
                </p>
              )}
              <p className="small-note">
                Заголовок и текст — до 1800 символов каждый. Ниже показан пример
                сообщения.
              </p>
              <p className="small-note">
                Переменные:{" "}
                {variables
                  .filter(
                    (v) =>
                      v !== "rides_to_next_level" &&
                      (rewardMode !== "discount" || !v.startsWith("bonus_")),
                  )
                  .map((v) => "{" + v + "}")
                  .join(", ")}
                . Прогресс считается по сумме аренд. Подарки выдаются менеджером
                по настроенным условиям программы.
              </p>
              <div className="form-grid">
                <Field label="Кнопка">
                  <input
                    value={config.cta}
                    maxLength={60}
                    disabled={busy}
                    onChange={(e) => set("cta", e.target.value)}
                    required
                  />
                </Field>
                <Field label="Экран">
                  <select
                    value={config.path}
                    disabled={busy}
                    onChange={(e) =>
                      set("path", e.target.value as NotificationConfig["path"])
                    }
                  >
                    {Object.entries({
                      "/onboarding": "Регистрация",
                      "/home": "Главная",
                      "/club": "Карта и привилегии",
                      "/rent": "Заявка на аренду",
                      "/profile": "Профиль",
                      "/history": "История",
                    }).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                {(
                  [
                    ["delayMinutes", "Задержка, минут", 0, 525600],
                    ["cooldownHours", "Повтор не чаще, часов", 0, 8760],
                    ["priority", "Приоритет · больше — раньше", 1, 100],
                  ] as const
                ).map(([key, label, min, max]) => (
                  <Field key={key} label={label}>
                    <input
                      type="number"
                      min={min}
                      max={max}
                      value={config[key]}
                      disabled={busy}
                      required
                      onChange={(e) => set(key, Number(e.target.value))}
                    />
                  </Field>
                ))}
                <Field label="Считать результат в течение">
                  <select
                    value={config.attributionDays}
                    disabled={busy}
                    onChange={(e) =>
                      set("attributionDays", Number(e.target.value))
                    }
                  >
                    {[1, 3, 7, 14, 30, 90].map((days) => (
                      <option key={days} value={days}>
                        {days} {days === 1 ? "дня" : "дней"}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Категория">
                  <select
                    value={config.category}
                    disabled={busy}
                    onChange={(e) =>
                      set(
                        "category",
                        e.target.value as NotificationConfig["category"],
                      )
                    }
                  >
                    <option value="service">Сервисное</option>
                    <option value="marketing">
                      Маркетинговое · нужно согласие
                    </option>
                    <option value="transactional">
                      Транзакционное · вне суточного лимита
                    </option>
                  </select>
                </Field>
                {["RET_01", "APP_01"].includes(rule.id) && (
                  <Field label="Перерыв, дней">
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={config.inactivityDays}
                      disabled={busy}
                      onChange={(e) =>
                        set("inactivityDays", Number(e.target.value))
                      }
                    />
                  </Field>
                )}
                {rule.id === "LOY_01" && (
                  <>
                    <Field label="Баланс больше, Bonus">
                      <input
                        type="number"
                        min={0}
                        value={config.minBonus}
                        disabled={busy}
                        onChange={(e) => set("minBonus", e.target.value)}
                      />
                    </Field>
                    <Field label="Поездок без списания">
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={config.unusedRides}
                        disabled={busy}
                        onChange={(e) =>
                          set("unusedRides", Number(e.target.value))
                        }
                      />
                    </Field>
                  </>
                )}
                {rule.id === "LVL_01" && (
                  <Field label="Осталось до уровня не более, ₽">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={Number(config.nearAmountKopecks) / 100}
                      disabled={busy}
                      onChange={(e) =>
                        set(
                          "nearAmountKopecks",
                          String(Math.round(Number(e.target.value) * 100)),
                        )
                      }
                    />
                  </Field>
                )}
                {rule.id.startsWith("EXP_") && (
                  <Field label="До истечения не более, часов">
                    <input
                      type="number"
                      min={1}
                      max={8760}
                      value={config.expireHours}
                      disabled={busy}
                      onChange={(e) =>
                        set("expireHours", Number(e.target.value))
                      }
                    />
                  </Field>
                )}
                {["BDAY_01", "ANNIV_01"].includes(rule.id) && (
                  <Field label="Час отправки · Москва">
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={config.morningHour}
                      disabled={busy}
                      onChange={(e) =>
                        set("morningHour", Number(e.target.value))
                      }
                    />
                  </Field>
                )}
              </div>
              <div className="panel panel-body">
                <strong>Пример подстановки · тестовые значения</strong>
                <h4>
                  {renderNotification(config.title, {
                    first_name: "Анна",
                    loyalty_level: "Black",
                    next_level: "VIP",
                    bonus_balance: "840",
                    bonus_added: "120",
                    ride_count: 12,
                    amount_to_next_level: "10 000",
                    discount_percent: 5,
                    bonus_expire_date: "30.09.2026",
                  })}
                </h4>
                <p>
                  {renderNotification(config.body, {
                    first_name: "Анна",
                    loyalty_level: "Black",
                    next_level: "VIP",
                    bonus_balance: "840",
                    bonus_added: "120",
                    ride_count: 12,
                    amount_to_next_level: "10 000",
                    discount_percent: 5,
                    bonus_expire_date: "30.09.2026",
                  })}
                </p>
              </div>
              <p className="small-note">
                Сохранение отменяет ожидающие сообщения прежней редакции этого
                сценария. Включение не отправляет старые события; проверки
                текущей неактивности начнутся после включения.
              </p>
              <FormMessage error={error} />
              <button className="button" disabled={busy || imageBusy}>
                {busy ? "Сохраняем…" : "Сохранить правило"}
              </button>
            </>
          )}
        </form>
      </details>
      {error && (
        <div className="panel-body">
          <FormMessage error={error} />
        </div>
      )}
    </article>
  );
}
