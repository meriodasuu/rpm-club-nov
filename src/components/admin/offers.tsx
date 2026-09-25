"use client";
import { ImageUpload } from "./image-upload";
import { useState } from "react";
import { Plus, ArrowUpRight, Send } from "lucide-react";
import {
  command,
  useResource,
  Dialog,
  Field,
  FormMessage,
  Spinner,
  Failure,
  Empty,
  TierBadge,
} from "@/components/shared";
import { PageHeading, type Row } from "./tables";
import type { StaffView } from "./shell";
import { money, date, rublesInput } from "@/lib/ui";
import { tierName, type TierRule } from "@/lib/loyalty/rules";
import { offerStatusLabel } from "@/lib/offers/availability";
export function OffersPage({ staff }: { staff: StaffView }) {
  const resource = useResource<{ items: Row[] }>("admin/offers"),
    [edit, setEdit] = useState<Row | null>(null),
    [campaign, setCampaign] = useState<Row | null>(null);
  return (
    <>
      <PageHeading
        title="Предложения клуба"
        subtitle="Предложения, доступные участникам клуба"
      >
        {staff.role !== "viewer" && (
          <button className="button" onClick={() => setEdit({})}>
            <Plus size={18} />
            Создать предложение
          </button>
        )}
      </PageHeading>
      {resource.error ? (
        <Failure error={resource.error} retry={resource.refresh} />
      ) : (
        <div className="offers-grid">
          {resource.data?.items.map((o) => (
            <article className="offer-admin-card" key={String(o.id)}>
              <div className="offer-image">
                <img
                  src={String(o.image_url || "/images/taycan.png")}
                  alt={String(o.car_name)}
                />
                <TierBadge tier={String(o.minimum_tier)} />
              </div>
              <div className="offer-admin-body">
                <span className="eyebrow">
                  {offerStatusLabel({
                    active: o.active === true,
                    start_at: String(o.start_at),
                    end_at: String(o.end_at),
                  })}{" "}
                  · {date(String(o.end_at))}
                </span>
                <h2>{String(o.title)}</h2>
                <p>{String(o.subtitle)}</p>
                <div className="offer-prices">
                  {o.new_price !== null && (
                    <strong>{money(String(o.new_price))}</strong>
                  )}
                  {o.old_price !== null && (
                    <del>{money(String(o.old_price))}</del>
                  )}
                </div>
                {staff.role !== "viewer" && (
                  <div className="detail-actions">
                    <button
                      className="button button-small button-outline"
                      onClick={() => setEdit(o)}
                    >
                      Редактировать
                      <ArrowUpRight size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={"Рассылка: " + o.title}
                      onClick={() => setCampaign(o)}
                    >
                      <Send size={18} />
                    </button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {resource.data && !resource.data.items.length && (
        <Empty title="Первый Drop впереди" />
      )}
      {edit && (
        <OfferEditor
          initial={edit}
          onClose={() => setEdit(null)}
          onDone={() => void resource.refresh()}
        />
      )}{" "}
      {campaign && (
        <CampaignDialog
          offer={campaign}
          onClose={() => setCampaign(null)}
          onEdit={() => {
            setEdit(campaign);
            setCampaign(null);
          }}
        />
      )}
    </>
  );
}
function OfferEditor({
  initial,
  onClose,
  onDone,
}: {
  initial: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  const program = useResource<{ tiers: TierRule[] }>("admin/tiers");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [image, setImage] = useState(String(initial.image_url ?? ""));
  const localDate = (v: unknown) =>
    v
      ? new Date(new Date(String(v)).getTime() + 3 * 3600000)
          .toISOString()
          .slice(0, 16)
      : "";
  async function save(form: HTMLFormElement) {
    setBusy(true);
    setError("");
    try {
      const f = new FormData(form);
      const value = (k: string) => String(f.get(k) ?? "");
      await command(
        "admin/offers" + (initial.id ? "/" + initial.id : ""),
        {
          title: value("title"),
          subtitle: value("subtitle"),
          car_name: value("car"),
          description: value("description"),
          image_url: image,
          old_price: value("old") ? rublesInput(value("old")) : null,
          new_price: value("new") ? rublesInput(value("new")) : null,
          minimum_tier: value("tier"),
          start_at: new Date(value("start") + ":00+03:00").toISOString(),
          end_at: new Date(value("end") + ":00+03:00").toISOString(),
          cta_text: value("cta"),
          cta_url: value("url"),
          active: f.get("active") === "on",
          expected_version: initial.version,
        },
        initial.id ? "PATCH" : "POST",
      );
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={initial.id ? "Редактировать Drop" : "Новый RPM Drop"}
      onClose={onClose}
      protectChanges
      busy={busy}
    >
      {program.error ? (
        <Failure error={program.error} retry={program.refresh} />
      ) : !program.data ? (
        <p role="status">
          <Spinner /> Загружаем уровни клуба…
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(e.currentTarget);
          }}
        >
          <Field label="Название">
            <input
              name="title"
              required
              maxLength={140}
              defaultValue={String(initial.title ?? "")}
            />
          </Field>
          <Field label="Подзаголовок">
            <input
              name="subtitle"
              maxLength={240}
              defaultValue={String(initial.subtitle ?? "")}
            />
          </Field>
          <Field label="Автомобиль">
            <input name="car" defaultValue={String(initial.car_name ?? "")} />
          </Field>
          <Field label="Описание">
            <textarea
              name="description"
              required
              maxLength={5000}
              rows={4}
              defaultValue={String(initial.description ?? "")}
            />
          </Field>
          <ImageUpload
            value={image}
            onChange={setImage}
            busy={busy}
            onBusy={setBusy}
          />
          <div className="form-grid">
            <Field label="Цена до, ₽">
              <input
                name="old"
                inputMode="decimal"
                defaultValue={
                  initial.old_price
                    ? String(Number(initial.old_price) / 100)
                    : ""
                }
              />
            </Field>
            <Field label="Цена клуба, ₽">
              <input
                name="new"
                inputMode="decimal"
                defaultValue={
                  initial.new_price
                    ? String(Number(initial.new_price) / 100)
                    : ""
                }
              />
            </Field>
            <Field label="Начало · Москва">
              <input
                name="start"
                type="datetime-local"
                required
                defaultValue={localDate(initial.start_at)}
              />
            </Field>
            <Field label="Окончание · Москва">
              <input
                name="end"
                type="datetime-local"
                required
                defaultValue={localDate(initial.end_at)}
              />
            </Field>
          </div>
          <Field label="Доступно от уровня">
            <select
              name="tier"
              defaultValue={String(initial.minimum_tier ?? "MEMBER")}
            >
              {program.data.tiers.map((tier) => (
                <option key={tier.code} value={tier.code}>
                  {tierName(tier)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Текст кнопки">
            <input
              name="cta"
              required
              maxLength={60}
              defaultValue={String(initial.cta_text ?? "Забронировать")}
            />
          </Field>
          <Field label="Ссылка RPM / Telegram">
            <input
              type="url"
              name="url"
              required
              defaultValue={String(
                initial.cta_url ?? "https://rpmrent.ru/cars",
              )}
            />
          </Field>
          <label className="checkbox-field">
            <input
              type="checkbox"
              name="active"
              defaultChecked={initial.active === true}
            />
            Опубликовать в клубе
          </label>
          <p className="small-note">
            Публикация сделает предложение доступным участникам выбранного
            уровня и выше. При включённом напоминании о предложениях они могут
            получить Telegram-сообщение с учётом согласия на маркетинг. Кнопка
            «Рассылка» запускает отдельную отправку.
          </p>
          <FormMessage error={error} />
          <button className="button button-full" disabled={busy}>
            {busy && <Spinner />}Сохранить предложение
          </button>
        </form>
      )}
    </Dialog>
  );
}
function CampaignDialog({
  offer,
  onClose,
  onEdit,
}: {
  offer: Row;
  onClose: () => void;
  onEdit: () => void;
}) {
  const r = useResource<{
      recipients: number;
      offer_version: number;
      available: boolean;
      blocked_reason: string | null;
    }>(`admin/offers/${offer.id}/campaigns`),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  return (
    <Dialog
      title="Рассылка RPM Drop"
      onClose={onClose}
      protectChanges
      busy={busy}
    >
      <p>{String(offer.title)}</p>
      <p className="small-note">
        Сообщение получат участники нужного уровня с согласием на маркетинг и
        доступным Telegram.
      </p>
      {r.data && (
        <strong className="stat-value">{r.data.recipients} получателей</strong>
      )}
      <FormMessage
        error={error || r.error?.message || r.data?.blocked_reason || undefined}
        success={success}
      />
      {r.data?.blocked_reason && (
        <button className="button button-outline button-full" onClick={onEdit}>
          Редактировать предложение
        </button>
      )}
      <button
        className="button button-full"
        disabled={busy || !r.data?.available || !!success}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const result = await command<{ recipients: number }>(
              `admin/offers/${offer.id}/campaigns`,
              { expectedVersion: r.data!.offer_version },
            );
            setSuccess(
              `В очередь поставлено ${result.recipients} сообщений. Результат — в разделе «Доставка».`,
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner /> : <Send size={17} />}Поставить рассылку в очередь
      </button>
    </Dialog>
  );
}
