"use client";
import { useState } from "react";
import { ImageUpload } from "./image-upload";
import { LifecycleNotifications } from "./notifications";
import { useUnsavedChanges } from "./unsaved";
import Link from "next/link";
import { Plus, Pencil, CarFront, Map, BookOpen, Bell } from "lucide-react";
import {
  command,
  useResource,
  Loading,
  Failure,
  Empty,
  Dialog,
  Field,
  FormMessage,
  Spinner,
} from "@/components/shared";
import { PageHeading } from "./tables";
import type { StaffView } from "./shell";
import { money, date, rublesInput } from "@/lib/ui";
import {
  triggerLabels,
  type ClubContent,
  type ContentKind,
  type RentalRequest,
  type TriggerRule,
} from "@/lib/club/contracts";

const names = { car: "Автопарк", route: "Маршруты", wiki: "База знаний" };
const categories: Record<string, string> = {
  general: "Общее",
  faq: "Частые вопросы",
  emergency: "ДТП и помощь",
  rules: "Условия",
};
export function ClubContentPage({
  kind,
  staff,
}: {
  kind: ContentKind;
  staff: StaffView;
}) {
  const synced = kind === "car" || kind === "route";
  const r = useResource<{
    items: ClubContent[];
    catalogSync?: { at: string; total: number; published: number } | null;
  }>("admin/club-content?kind=" + kind, synced ? 5000 : 0);
  const [editing, setEditing] = useState<Partial<ClubContent> | null>(null);
  const Icon = kind === "car" ? CarFront : kind === "route" ? Map : BookOpen;
  return (
    <>
      <PageHeading
        title={names[kind]}
        subtitle={
          synced
            ? `${kind === "car" ? "Автопарк синхронизируется" : "Маршруты синхронизируются"} с сайтом RPM Rent. Изменения появятся здесь автоматически.`
            : "Опубликованные материалы видны участникам клуба"
        }
      >
        {synced ? (
          <a
            className="button"
            href={
              kind === "car"
                ? "https://rpmrent.ru/admin/cars"
                : "https://rpmrent.ru/admin/locations"
            }
            target="_blank"
            rel="noreferrer"
          >
            {kind === "car"
              ? "Открыть автопарк сайта"
              : "Открыть локации сайта"}
          </a>
        ) : (
          staff.role !== "viewer" && (
            <button className="button" onClick={() => setEditing({ kind })}>
              <Plus size={18} />
              Добавить
            </button>
          )
        )}
      </PageHeading>
      {synced && r.data && (
        <p className="small-note">
          {r.data.catalogSync
            ? `Последняя синхронизация: ${new Date(r.data.catalogSync.at).toLocaleString("ru-RU")}. Опубликовано: ${r.data.catalogSync.published}.`
            : "Ожидаем первую синхронизацию с сайтом."}
        </p>
      )}
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : (
        <div className="content-admin-grid">
          {r.data.items.map((item) => (
            <article className="panel content-admin-card" key={item.id}>
              {item.image_url ? (
                <img className="content-cover" src={item.image_url} alt="" />
              ) : (
                <div className="content-placeholder">
                  <Icon size={36} />
                </div>
              )}
              <div className="panel-body">
                <span className="eyebrow">
                  {item.active ? "ОПУБЛИКОВАНО" : "ЧЕРНОВИК"}
                </span>
                <h2>{item.title}</h2>
                <p>{item.summary}</p>
                {kind === "car" && (
                  <strong>{money(item.daily_price_kopecks)} / сутки</strong>
                )}
                {kind === "wiki" && (
                  <p className="small-note">{categories[item.category]}</p>
                )}
                {!synced && staff.role !== "viewer" && (
                  <button
                    className="button button-outline button-full"
                    onClick={() => setEditing(item)}
                  >
                    <Pencil size={16} />
                    Редактировать
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {r.data?.items.length === 0 && (
        <Empty title="Здесь пока пусто">
          {synced
            ? `Добавьте ${kind === "car" ? "автомобиль" : "локацию"} в админке сайта RPM Rent — запись появится здесь автоматически.`
            : "Добавьте статью, чтобы она появилась в клубе."}
        </Empty>
      )}
      {editing && (
        <ContentEditor
          initial={editing}
          kind={kind}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void r.refresh();
          }}
        />
      )}
    </>
  );
}
function ContentEditor({
  initial,
  kind,
  onClose,
  onDone,
}: {
  initial: Partial<ClubContent>;
  kind: ContentKind;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [image, setImage] = useState(initial.image_url ?? "");
  return (
    <Dialog
      title={initial.id ? "Редактирование" : "Новая запись"}
      onClose={onClose}
      protectChanges
      busy={busy}
    >
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const f = new FormData(e.currentTarget),
              value = (k: string) => String(f.get(k) ?? "");
            await command(
              "admin/club-content" + (initial.id ? "/" + initial.id : ""),
              {
                kind,
                title: value("title"),
                summary: value("summary"),
                body: value("body"),
                imageUrl: image,
                linkUrl: value("link"),
                category: value("category") || "general",
                dailyPriceKopecks:
                  kind === "car" ? rublesInput(value("price")) : "0",
                distanceKm: Number(value("distance")),
                durationMinutes: Number(value("duration")),
                active: f.has("active"),
                expectedVersion: initial.version,
              },
              initial.id ? "PATCH" : "POST",
            );
            onDone();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Название">
          <input
            name="title"
            maxLength={160}
            minLength={2}
            defaultValue={initial.title}
            required
          />
        </Field>
        <Field label="Краткое описание">
          <textarea
            name="summary"
            maxLength={500}
            rows={2}
            defaultValue={initial.summary}
          />
        </Field>
        {kind === "wiki" && (
          <Field label="Раздел">
            <select name="category" defaultValue={initial.category ?? "faq"}>
              {Object.entries(categories).map(([key, value]) => (
                <option key={key} value={key}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={kind === "car" ? "Описание и условия аренды" : "Текст"}>
          <textarea
            name="body"
            maxLength={12000}
            rows={7}
            defaultValue={initial.body}
          />
        </Field>
        <ImageUpload
          value={image}
          onChange={setImage}
          busy={busy}
          onBusy={setBusy}
        />
        <Field
          label={
            kind === "route"
              ? "Ссылка на маршрут в картах · https://"
              : "Дополнительная ссылка · https://"
          }
        >
          <input name="link" type="url" defaultValue={initial.link_url} />
        </Field>
        {kind === "car" && (
          <Field label="Стоимость суток, ₽">
            <input
              name="price"
              inputMode="decimal"
              defaultValue={
                initial.daily_price_kopecks
                  ? String(Number(initial.daily_price_kopecks) / 100)
                  : ""
              }
              required
            />
          </Field>
        )}
        {kind === "route" && (
          <div className="form-grid">
            <Field label="Длина, км">
              <input
                name="distance"
                type="number"
                min={0}
                max={50000}
                defaultValue={initial.distance_km ?? 0}
              />
            </Field>
            <Field label="Время в пути, минут">
              <input
                name="duration"
                type="number"
                min={0}
                max={50000}
                defaultValue={initial.duration_minutes ?? 0}
              />
            </Field>
          </div>
        )}
        <label className="checkbox-field">
          <input
            name="active"
            type="checkbox"
            defaultChecked={initial.active}
          />
          Опубликовать в клубе
        </label>
        {kind === "route" && (
          <p className="small-note">
            При первом опубликовании маршрута участники с согласием на маркетинг
            могут получить Telegram-сообщение, если включено уведомление «Новый
            маршрут». Черновик не запускает рассылку.
          </p>
        )}
        <FormMessage error={error} />
        <button className="button button-full" disabled={busy}>
          {busy && <Spinner />}Сохранить
        </button>
      </form>
    </Dialog>
  );
}
const requestLabels: Record<string, string> = {
  pending: "На рассмотрении",
  accepted: "Подтверждена",
  declined: "Отклонена",
  cancelled: "Отменена клиентом",
};
export function RentalRequestsPage({
  staff,
  embedded = false,
  statusFilter,
}: {
  staff: StaffView;
  embedded?: boolean;
  statusFilter?: "pending" | "cancelled";
}) {
  const [status, setStatus] = useState("pending"),
    [selected, setSelected] = useState<{
      item: RentalRequest;
      decision: "accepted" | "declined";
    } | null>(null);
  const effectiveStatus =
    statusFilter === "cancelled" ? "closed" : (statusFilter ?? status);
  const r = useResource<{ items: RentalRequest[] }>(
    "admin/rental-requests?status=" + effectiveStatus,
    30000,
  );
  const items = r.data?.items ?? [];
  return (
    <>
      {!embedded && (
        <PageHeading
          title="Заявки на аренду"
          subtitle="Подтверждение создаст аренду со статусом «Принята» и зафиксированной стоимостью"
        />
      )}
      {embedded && (
        <h2>
          {statusFilter === "cancelled"
            ? "Отклонённые и отменённые заявки"
            : "Требуют решения"}
        </h2>
      )}
      {!embedded && (
        <div className="filter-bar">
          <select
            aria-label="Статус заявки"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">Все статусы</option>
            {Object.entries(requestLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      )}
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty title="Заявок пока нет" />
      ) : (
        <div className="request-admin-list">
          {items.map((item) => (
            <section className="panel request-admin-card" key={item.id}>
              <div>
                <span className="eyebrow">{requestLabels[item.status]}</span>
                <h2>{item.car_name}</h2>
                <Link href={"/admin/customers/" + item.user_id}>
                  {item.name} · {item.phone}
                </Link>
                <p>
                  {date(item.start_date)} — {date(item.end_date)} · {item.days}{" "}
                  сут.
                </p>
                <strong>{money(item.total_kopecks)}</strong>
                {item.rpm_rent_managed && (
                  <p className="small-note">
                    {item.rpm_rent_number
                      ? `RPM Rent · заявка #${item.rpm_rent_number}`
                      : "Передаём в RPM Rent…"}
                  </p>
                )}
                {item.rpm_rent_sync_error && (
                  <p className="form-error" role="alert">
                    {item.rpm_rent_sync_error}
                  </p>
                )}
                {item.rpm_rent_notification_pending &&
                  item.status !== "cancelled" && (
                    <p className="small-note">
                      Уведомление менеджерам ожидает отправки.
                    </p>
                  )}
                {item.pickup_at && (
                  <p className="small-note">
                    Выдача:{" "}
                    {new Date(item.pickup_at).toLocaleTimeString("ru-RU", {
                      timeZone: "Europe/Moscow",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    (Москва)
                  </p>
                )}
                {item.discount_bps > 0 && (
                  <p className="small-note">
                    Скидка {item.discount_bps / 100}% ·{" "}
                    {money(
                      (
                        BigInt(item.discount_kopecks) -
                        BigInt(item.roulette_effect_kopecks ?? "0")
                      ).toString(),
                    )}
                  </p>
                )}
                {(
                  (
                    item as RentalRequest & {
                      roulette_awards?: {
                        id: string;
                        title: string;
                        terms: string;
                        claim_code: string;
                        status: string;
                        effect_kopecks: string;
                      }[];
                    }
                  ).roulette_awards ?? []
                ).map((award) => (
                  <p className="request-prize" key={award.id}>
                    <strong>Приз: {award.title}</strong> · код{" "}
                    <code>{award.claim_code}</code>
                    {BigInt(award.effect_kopecks) > 0n && (
                      <> · скидка {money(award.effect_kopecks)}</>
                    )}
                    {award.status === "redeemed" && (
                      <small>Использован · архив</small>
                    )}
                  </p>
                ))}
                {item.comment && (
                  <p className="preserve-lines">{item.comment}</p>
                )}
                {item.staff_note && (
                  <p className="small-note">Ответ: {item.staff_note}</p>
                )}
              </div>
              {item.rpm_rent_managed ? (
                <div>
                  <a
                    className="button"
                    href={
                      item.rpm_rent_id
                        ? `https://rpmrent.ru/admin/bookings?booking=${encodeURIComponent(item.rpm_rent_id)}`
                        : "https://rpmrent.ru/admin/bookings"
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    Открыть в RPM Rent
                  </a>
                  {item.rental_id && (
                    <Link href="/admin/rentals" className="text-link">
                      Отметить оплату аренды →
                    </Link>
                  )}
                </div>
              ) : item.status === "pending" && staff.role !== "viewer" ? (
                <div className="detail-actions">
                  <button
                    className="button"
                    onClick={() => setSelected({ item, decision: "accepted" })}
                  >
                    Подтвердить
                  </button>
                  <button
                    className="button button-outline"
                    onClick={() => setSelected({ item, decision: "declined" })}
                  >
                    Отклонить
                  </button>
                </div>
              ) : item.rental_id ? (
                <Link href="/admin/rentals" className="text-link">
                  К арендам →
                </Link>
              ) : null}
            </section>
          ))}
        </div>
      )}
      {selected && (
        <RequestDecision
          item={selected.item}
          initialDecision={selected.decision}
          onClose={() => setSelected(null)}
          onDone={() => {
            setSelected(null);
            void r.refresh();
          }}
        />
      )}
    </>
  );
}
function RequestDecision({
  item,
  initialDecision = "accepted",
  onClose,
  onDone,
}: {
  item: RentalRequest;
  initialDecision?: "accepted" | "declined";
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [decision, setDecision] = useState(initialDecision);
  return (
    <Dialog title={item.car_name} onClose={onClose} protectChanges busy={busy}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const f = new FormData(e.currentTarget);
          try {
            await command("admin/rental-requests/" + item.id, {
              status: f.get("status"),
              note: f.get("note"),
              ...(decision === "accepted"
                ? { pickupTime: f.get("pickupTime") }
                : {}),
            });
            onDone();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          {date(item.start_date)} — {date(item.end_date)} ·{" "}
          {money(item.total_kopecks)}
        </p>
        <Field label="Решение">
          <select
            name="status"
            value={decision}
            onChange={(e) =>
              setDecision(e.target.value as "accepted" | "declined")
            }
          >
            <option value="accepted">Подтвердить аренду</option>
            <option value="declined">Отклонить заявку</option>
          </select>
        </Field>
        {decision === "accepted" && (
          <Field
            label="Время выдачи (Москва)"
            hint="Согласуйте время с клиентом. За 2 часа до выдачи бот отправит напоминание."
          >
            <input name="pickupTime" type="time" required />
          </Field>
        )}
        <Field label="Ответ клиенту">
          <textarea name="note" required minLength={3} maxLength={1000} />
        </Field>
        <p className="small-note">
          Перед подтверждением согласуйте наличие автомобиля и условия с
          клиентом. Пересечения с другими подтверждёнными заявками проверяются
          автоматически.
        </p>
        <FormMessage error={error} />
        <button className="button button-full" disabled={busy}>
          {busy && <Spinner />}Сохранить решение
        </button>
      </form>
    </Dialog>
  );
}
export function TriggerRulesPage() {
  const r = useResource<{ items: TriggerRule[]; weatherReady: boolean }>(
    "admin/trigger-rules",
  );
  const enabledCount = r.data?.items.filter((rule) => rule.enabled).length ?? 0;
  return (
    <>
      <PageHeading
        title="Автоуведомления"
        subtitle="Бот отправляет сообщения по событиям. Результаты доступны в разделе «Доставка сообщений»"
      />
      <LifecycleNotifications />
      <h2>Поездки, публикации и погода</h2>
      <p className="small-note">
        {enabledCount} из {r.data?.items.length ?? 0} включено. Нажмите
        «Включить» рядом с нужным событием. Старые публикации после включения не
        рассылаются.
      </p>
      {r.error ? (
        <Failure error={r.error} />
      ) : !r.data ? (
        <Loading />
      ) : (
        r.data.items
          .filter((rule) => rule.kind !== "weather")
          .map((rule) => (
            <TriggerForm
              key={JSON.stringify(rule)}
              rule={rule}
              weatherReady={r.data!.weatherReady}
              onDone={r.refresh}
            />
          ))
      )}
    </>
  );
}
function TriggerForm({
  rule,
  weatherReady,
  onDone,
}: {
  rule: TriggerRule;
  weatherReady: boolean;
  onDone: () => Promise<void>;
}) {
  const guard = useUnsavedChanges();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [dirty, setDirty] = useState(false);
  const weatherBlocked =
    rule.kind === "weather" && !weatherReady && !rule.enabled;
  const timing =
    rule.kind === "before_rental"
      ? `За ${rule.lead_hours} ч до выдачи автомобиля`
      : rule.kind === "weather"
        ? `Прогноз за ${rule.lead_hours} ч до выдачи`
        : rule.kind === "after_rental"
          ? "После завершения аренды"
          : rule.kind === "offer_reminder"
            ? "После публикации предложения"
            : "После публикации маршрута";
  return (
    <article className="panel trigger-form">
      <div className="panel-header">
        <div>
          <h2>
            <Bell size={18} /> {triggerLabels[rule.kind]}
          </h2>
          <span className="small-note">
            {weatherBlocked
              ? "Недоступно: нужен ключ погоды"
              : rule.enabled
                ? "Включено"
                : "Выключено"}{" "}
            · {timing}
          </span>
        </div>
        <button
          type="button"
          className={rule.enabled ? "button button-outline" : "button"}
          disabled={busy || weatherBlocked}
          onClick={async () => {
            if (dirty) {
              setError("Сначала сохраните изменения в настройках.");
              return;
            }
            setBusy(true);
            setError("");
            try {
              await command("admin/trigger-rules", {
                kind: rule.kind,
                enabled: !rule.enabled,
                message: rule.message,
                leadHours: rule.lead_hours,
                city: rule.city,
                latitude: rule.latitude,
                longitude: rule.longitude,
              });
              await onDone();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Сохраняем…" : rule.enabled ? "Выключить" : "Включить"}
        </button>
      </div>
      {(error || success) && (
        <div className="panel-body">
          <FormMessage error={error} success={success} />
        </div>
      )}
      <details>
        <summary className="panel-body">Изменить текст и условия</summary>
        <form
          className="form-stack"
          onChange={() => {
            guard.markDirty();
            setDirty(true);
            setSuccess("");
          }}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setSuccess("");
            const f = new FormData(e.currentTarget);
            try {
              await command("admin/trigger-rules", {
                kind: rule.kind,
                enabled: rule.enabled,
                message: f.get("message"),
                leadHours: Number(f.get("hours") ?? 0),
                city: f.get("city") ?? "",
                latitude: f.get("lat") ? Number(f.get("lat")) : null,
                longitude: f.get("lon") ? Number(f.get("lon")) : null,
              });
              setSuccess("Настройки сохранены");
              guard.markSaved();
              setDirty(false);
              await onDone();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="panel-body form-stack">
            <Field label="Текст сообщения">
              <textarea
                name="message"
                disabled={busy}
                rows={3}
                maxLength={1800}
                minLength={3}
                defaultValue={rule.message}
                required
              />
            </Field>
            {(rule.kind === "before_rental" || rule.kind === "weather") && (
              <Field
                label={
                  rule.kind === "weather"
                    ? "За сколько часов до выдачи отправить прогноз"
                    : "За сколько часов до выдачи"
                }
              >
                <input
                  name="hours"
                  disabled={busy}
                  type="number"
                  min={1}
                  max={168}
                  defaultValue={rule.lead_hours}
                  required
                />
              </Field>
            )}
            {rule.kind === "weather" && (
              <>
                {!weatherReady && (
                  <p className="form-error">
                    Для коммерческого использования нужен ключ API Standard или
                    выше. Добавьте его на сервере в OPEN_METEO_API_KEY; при
                    включении ключ будет проверен запросом к Open-Meteo.
                  </p>
                )}
                <Field label="Город">
                  <input
                    name="city"
                    defaultValue={rule.city}
                    maxLength={120}
                    disabled={busy}
                  />
                </Field>
                <p className="small-note">
                  В уведомление войдут минимальная и максимальная температура и
                  вероятность осадков на день выдачи. Рассылка адресована
                  участникам с согласием на маркетинговые сообщения.
                </p>
                <div className="form-grid">
                  <Field label="Широта">
                    <input
                      name="lat"
                      disabled={busy}
                      type="number"
                      step="any"
                      min={-90}
                      max={90}
                      defaultValue={rule.latitude ?? ""}
                    />
                  </Field>
                  <Field label="Долгота">
                    <input
                      name="lon"
                      disabled={busy}
                      type="number"
                      step="any"
                      min={-180}
                      max={180}
                      defaultValue={rule.longitude ?? ""}
                    />
                  </Field>
                </div>
              </>
            )}
            <FormMessage error={error} success={success} />
            <button className="button" disabled={busy}>
              {busy && <Spinner />}Сохранить
            </button>
          </div>
        </form>
      </details>
    </article>
  );
}
