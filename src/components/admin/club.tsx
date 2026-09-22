"use client";
import { useState } from "react";
import { ImageUpload } from "./image-upload";
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
  const r = useResource<{ items: ClubContent[] }>(
    "admin/club-content?kind=" + kind,
  );
  const [editing, setEditing] = useState<Partial<ClubContent> | null>(null);
  const Icon = kind === "car" ? CarFront : kind === "route" ? Map : BookOpen;
  return (
    <>
      <PageHeading
        title={names[kind]}
        subtitle={
          kind === "car"
            ? "Автомобили и стоимость суток для заявок из Mini App"
            : "Опубликованные материалы видны участникам клуба"
        }
      >
        {staff.role !== "viewer" && (
          <button className="button" onClick={() => setEditing({ kind })}>
            <Plus size={18} />
            Добавить
          </button>
        )}
      </PageHeading>
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
                {staff.role !== "viewer" && (
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
          Добавьте{" "}
          {kind === "car"
            ? "автомобиль"
            : kind === "route"
              ? "маршрут"
              : "статью"}
          , чтобы он появился в клубе.
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
export function RentalRequestsPage({ staff }: { staff: StaffView }) {
  const [status, setStatus] = useState("pending"),
    [selected, setSelected] = useState<RentalRequest | null>(null);
  const r = useResource<{ items: RentalRequest[] }>(
    "admin/rental-requests?status=" + status,
    30000,
  );
  return (
    <>
      <PageHeading
        title="Заявки на аренду"
        subtitle="Подтверждение создаст аренду со статусом «Принята» и зафиксированной стоимостью"
      />
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
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : r.data.items.length === 0 ? (
        <Empty title="Заявок пока нет" />
      ) : (
        <div className="request-admin-list">
          {r.data.items.map((item) => (
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
                    {money(item.discount_kopecks)}
                  </p>
                )}
                {item.comment && (
                  <p className="preserve-lines">{item.comment}</p>
                )}
                {item.staff_note && (
                  <p className="small-note">Ответ: {item.staff_note}</p>
                )}
              </div>
              {item.status === "pending" && staff.role !== "viewer" ? (
                <button className="button" onClick={() => setSelected(item)}>
                  Обработать
                </button>
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
          item={selected}
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
  onClose,
  onDone,
}: {
  item: RentalRequest;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [decision, setDecision] = useState("accepted");
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
            onChange={(e) => setDecision(e.target.value)}
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
  return (
    <>
      <PageHeading
        title="Автоуведомления"
        subtitle="Бот отправляет сообщения по событиям. Результаты доступны в разделе «Доставка сообщений»"
      />
      <p className="small-note">
        До аренды — за указанное в правиле число часов до времени выдачи
        (Москва). После аренды — сразу после статуса «Завершена», независимо от
        оплаты. Предложения и маршруты — после публикации. Проверка событий —
        каждую минуту; сообщения отправляются через очередь. Старые публикации
        при включении рассылки не отправляются.
      </p>
      {r.error ? (
        <Failure error={r.error} />
      ) : !r.data ? (
        <Loading />
      ) : (
        r.data.items.map((rule) => (
          <TriggerForm
            key={rule.kind}
            rule={rule}
            weatherReady={r.data!.weatherReady}
          />
        ))
      )}
    </>
  );
}
function TriggerForm({
  rule,
  weatherReady,
}: {
  rule: TriggerRule;
  weatherReady: boolean;
}) {
  const guard = useUnsavedChanges();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  return (
    <form
      className="panel trigger-form"
      onChange={() => {
        guard.markDirty();
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
            enabled: f.has("enabled"),
            message: f.get("message"),
            leadHours: Number(f.get("hours") ?? 0),
            city: f.get("city") ?? "",
            latitude: f.get("lat") ? Number(f.get("lat")) : null,
            longitude: f.get("lon") ? Number(f.get("lon")) : null,
          });
          setSuccess("Настройки сохранены");
          guard.markSaved();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="panel-header">
        <h2>
          <Bell size={18} /> {triggerLabels[rule.kind]}
        </h2>
        <label className="checkbox-field">
          <input
            name="enabled"
            type="checkbox"
            defaultChecked={rule.enabled}
            disabled={busy}
          />
          Включено
        </label>
      </div>
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
          <Field label="За сколько часов до выдачи">
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
              <p className="small-note">
                Сервис прогноза ещё не подключён. Нужен ключ Open-Meteo для
                коммерческого использования.
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
  );
}
