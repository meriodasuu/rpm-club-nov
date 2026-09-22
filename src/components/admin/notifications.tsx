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
  blockedNotifications,
  renderNotification,
  variables,
  type NotificationRule,
  type NotificationConfig,
} from "@/lib/notifications/contracts";
import { useUnsavedChanges } from "./unsaved";
import { DataTable, type Row } from "./tables";
import { date } from "@/lib/ui";
export function LifecycleNotifications() {
  const r = useResource<{
    rules: NotificationRule[];
    stats: Row[];
    logs: Row[];
    limits: { service: number; marketing: number };
  }>("admin/notifications");
  const [error, setError] = useState("");
  return (
    <section>
      <h2>Сценарии участника</h2>
      <p className="small-note">
        Оплата на месте. Тексты учитывают скидки; старые Bonus показываются
        только при наличии. Новые правила выключены до настройки. День рождения
        и годовщина — поздравления, без автоматического начисления подарка.
      </p>
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : (
        <>
          <div className="panel panel-body">
            <h3>Лимит на участника в сутки · Москва</h3>
            <p>
              Не более одного сервисного и одного маркетингового сообщения из
              всех сценариев клуба. Транзакционные сообщения — вне лимита. 0
              отключает категорию.
            </p>
            <div className="form-grid">
              {(["service", "marketing"] as const).map((key) => (
                <Field
                  key={key}
                  label={key === "service" ? "Сервисные" : "Маркетинговые"}
                >
                  <select
                    value={r.data!.limits[key]}
                    onChange={async (e) => {
                      try {
                        await command("admin/notification-limits", {
                          ...r.data!.limits,
                          [key]: Number(e.target.value),
                        });
                        await r.refresh();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <option value={0}>0</option>
                    <option value={1}>1</option>
                  </select>
                </Field>
              ))}
            </div>
            <FormMessage error={error} />
          </div>
          {r.data.rules.map((rule) => (
            <NotificationEditor
              key={rule.id + ":" + rule.version}
              rule={rule}
              onDone={r.refresh}
            />
          ))}
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
                <td>{String(s.trigger_id)}</td>
                <td>{String(s.sent)}</td>
                <td>{String(s.opened)}</td>
                <td>{String(s.converted)}</td>
                <td>
                  {Number(s.sent)
                    ? ((100 * Number(s.converted)) / Number(s.sent)).toFixed(
                        1,
                      ) + "%"
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
                  {String(s.trigger_id)}
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
        </>
      )}
    </section>
  );
}
function NotificationEditor({
  rule,
  onDone,
}: {
  rule: NotificationRule;
  onDone: () => Promise<void>;
}) {
  const [config, setConfig] = useState<NotificationConfig>({
      ...rule.config,
      expectedVersion: rule.version,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const guard = useUnsavedChanges();
  const set = <K extends keyof NotificationConfig>(
    key: K,
    value: NotificationConfig[K],
  ) => {
    guard.markDirty();
    setConfig((c) => ({ ...c, [key]: value }));
  };
  const blocked = blockedNotifications[rule.id];
  return (
    <details className="panel">
      <summary className="panel-header">
        {rule.id} · {notificationNames[rule.id]} ·{" "}
        {blocked ? "Недоступно" : config.enabled ? "Включено" : "Выключено"}
      </summary>
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
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={config.enabled}
                disabled={busy}
                onChange={(e) => set("enabled", e.target.checked)}
              />
              Включить сценарий
            </label>
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
            <p className="small-note">
              Переменные:{" "}
              {variables
                .filter((v) => v !== "rides_to_next_level")
                .map((v) => "{" + v + "}")
                .join(", ")}
              . Прогресс считается по обороту. Не обещайте новые Bonus или
              подарок без фактического начисления.
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
                    "/profile": "Профиль и Bonus",
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
                  ["attributionDays", "Окно конверсии, дней", 1, 90],
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
                    onChange={(e) => set("expireHours", Number(e.target.value))}
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
                    onChange={(e) => set("morningHour", Number(e.target.value))}
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
              сценария. Включение не отправляет старые события; проверки текущей
              неактивности и оставшихся Bonus начнутся после включения.
            </p>
            <FormMessage error={error} />
            <button className="button" disabled={busy}>
              {busy ? "Сохраняем…" : "Сохранить правило"}
            </button>
          </>
        )}
      </form>
    </details>
  );
}
