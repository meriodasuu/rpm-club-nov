"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import {
  CarFront,
  Map,
  BookOpen,
  ScrollText,
  ArrowUpRight,
  ArrowRight,
  ChevronRight,
} from "lucide-react";
import {
  command,
  api,
  useResource,
  Loading,
  Failure,
  Empty,
  FormMessage,
} from "@/components/shared";
import { date, money } from "@/lib/ui";
import { resolveTierBenefits, tierName } from "@/lib/loyalty/rules";
import type { AccountSnapshot } from "@/lib/loyalty/types";
import { type ClubContent, type RentalRequest } from "@/lib/club/contracts";

import {
  BookingDialog,
  CarCard,
  CarGallery,
  type BookingDraft,
} from "./rental";

export function ClubLinks() {
  return (
    <nav className="club-shortcuts" aria-label="Сервисы клуба">
      {[
        ["/rent", "Аренда", CarFront],
        ["/routes", "Маршруты", Map],
        ["/conditions", "Условия", ScrollText],
        ["/wiki", "Wiki и помощь", BookOpen],
      ].map(([href, title, Icon]) => {
        const Component = Icon as typeof Map;
        return (
          <Link href={String(href)} key={String(href)}>
            <Component size={21} />
            <span>{String(title)}</span>
            <ChevronRight size={15} />
          </Link>
        );
      })}
    </nav>
  );
}
export function RentalScreen() {
  const r = useResource<{ items: ClubContent[] }>(
    "club/content?kind=car",
    5000,
  );
  const [selected, setSelected] = useState<ClubContent | null>(null),
    [requestVersion, setRequestVersion] = useState(0);
  const [offer, setOffer] = useState<{
    id: string;
    title: string;
    offer_type: string;
    car_id: string | null;
    discount_bps: number | null;
    version: number;
  } | null>(null);
  const [offerError, setOfferError] = useState("");
  const [resume, setResume] = useState<BookingDraft | null>(null),
    [resumeError, setResumeError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const draftId = params.get("draft");
    const offerId = params.get("offer");
    if (draftId)
      void api<BookingDraft>("me/booking-draft?id=" + encodeURIComponent(draftId))
        .then(setResume)
        .catch((e) => setResumeError(e.message));
    if (offerId && /^[0-9a-f-]{36}$/i.test(offerId))
      void api<typeof offer>("offers/" + encodeURIComponent(offerId))
        .then((value) => {
          if (
            value?.offer_type !== "catalog" ||
            !value.car_id ||
            !value.discount_bps
          )
            throw new Error("Предложение не связано с доступной арендой");
          setOffer(value);
        })
        .catch((e: Error) => setOfferError(e.message));
  }, []);
  const offerCar = offer && r.data?.items.find((item) => item.id === offer.car_id);
  const selectedCar = offer
    ? offerCar
    : r.data?.items.find((c) => c.id === (selected?.id ?? resume?.car_id));
  return (
    <>
      <h1>Автопарк</h1>
      <p className="screen-subtitle">Выберите автомобиль для поездки</p>
      <FormMessage
        error={
          offerError ||
          resumeError ||
          (offer && r.data && !offerCar
            ? "Автомобиль из предложения сейчас недоступен в каталоге"
            : "")
        }
      />
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : r.data.items.length === 0 ? (
        <Empty title="Автопарк скоро появится">
          Автомобили добавляются командой RPM.
        </Empty>
      ) : (
        <div className="catalog-list">
          {r.data.items.filter((car) => !offer || car.id === offer.car_id).map((car) => (
            <CarCard
              key={car.id}
              car={car}
              onBook={() => {
                setResume(null);
                setSelected(car);
              }}
            />
          ))}
        </div>
      )}
      <h2 className="section-title" id="my-requests">
        Мои заявки
      </h2>
      <RentalRequests key={requestVersion} />
      {selectedCar && (
        <BookingDialog
          car={selectedCar}
          initial={resume}
          offer={offer && offer.car_id === selectedCar.id ? {
            id: offer.id,
            title: offer.title,
            discount_bps: offer.discount_bps!,
            version: offer.version,
          } : null}
          onClose={() => {
            setSelected(null);
            setResume(null);
          }}
          onDone={() => {
            setSelected(null);
            setResume(null);
            setRequestVersion((v) => v + 1);
            requestAnimationFrame(() =>
              document
                .getElementById("my-requests")
                ?.scrollIntoView({ behavior: "smooth" }),
            );
          }}
        />
      )}
    </>
  );
}
export function RentalRequests() {
  const r = useResource<{ items: RentalRequest[] }>(
    "me/rental-requests",
    30000,
  );
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("");
  const labels = {
    pending: "На рассмотрении",
    accepted: "Подтверждена",
    declined: "Отклонена",
    cancelled: "Отменена",
  };
  if (r.error) return <Failure error={r.error} retry={r.refresh} />;
  if (!r.data) return <Loading />;
  if (!r.data.items.length)
    return <Empty title="Вы ещё не отправляли заявок" />;
  return (
    <div className="requests-list">
      <FormMessage error={error} />
      {r.data.items.map((item) => (
        <article className="rental-request" key={item.id}>
          <span className="eyebrow">
            {item.rpm_rent_status === "IN_PROGRESS"
              ? "В обработке"
              : item.rpm_rent_status === "COMPLETED"
                ? "Поездка завершена"
                : labels[item.status]}
          </span>
          <h3>{item.car_name}</h3>
          <p>
            {date(item.start_date)} — {date(item.end_date)}
          </p>
          <strong>{money(item.total_kopecks)}</strong>
          {item.discount_bps > 0 && (
            <p className="small-note">Скидка {item.discount_bps / 100}%</p>
          )}
          {((item as RentalRequest & { roulette_awards?: { id: string; title: string; terms: string; claim_code: string; status: string; effect_kopecks: string }[] }).roulette_awards ?? []).map((award) => (
            <div className="request-prize" key={award.id}>
              <strong>{award.title}</strong> · код <code>{award.claim_code}</code>
              {BigInt(award.effect_kopecks) > 0n && <span> · −{money(award.effect_kopecks)}</span>}
              {award.status === "redeemed" && <small>Приз использован и находится в архиве</small>}
            </div>
          ))}
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
          {item.staff_note && (
            <p className="preserve-lines small-note">{item.staff_note}</p>
          )}
          {item.status === "pending" && (
            <button
              className="text-link"
              disabled={busy === item.id}
              onClick={async () => {
                setBusy(item.id);
                setError("");
                try {
                  await command(
                    "me/rental-requests/" + item.id + "/cancel",
                    {},
                  );
                  await r.refresh();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              Отменить заявку
            </button>
          )}
        </article>
      ))}
    </div>
  );
}
export function RoutesScreen() {
  const r = useResource<{ items: ClubContent[] }>(
    "club/content?kind=route",
    5000,
  );
  return (
    <>
      <h1>Куда отправиться</h1>
      <p className="screen-subtitle">Маршруты для поездок с RPM</p>
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : !r.data.items.length ? (
        <Empty title="Готовим новые маршруты" />
      ) : (
        r.data.items.map((item) => (
          <article className="catalog-card" key={item.id}>
            {item.image_url && <CarGallery car={item} />}
            <div className="catalog-body">
              <h2>{item.title}</h2>
              <p>{item.summary}</p>
              <p className="small-note">
                {item.distance_km > 0 ? item.distance_km + " км" : ""}
                {item.duration_minutes > 0
                  ? " · " + item.duration_minutes + " мин. в пути"
                  : ""}
              </p>
              <p className="preserve-lines">{item.body}</p>
              {item.route_details?.address && (
                <p className="preserve-lines">
                  <strong>Адрес</strong>
                  <br />
                  {item.route_details.address}
                </p>
              )}
              {item.route_details?.workingHours && (
                <p className="preserve-lines">
                  <strong>Часы работы</strong>
                  <br />
                  {item.route_details.workingHours}
                </p>
              )}
              {item.route_details?.directions && (
                <p className="preserve-lines">
                  <strong>Как добраться</strong>
                  <br />
                  {item.route_details.directions}
                </p>
              )}
              {item.link_url && (
                <a
                  className="button button-outline button-full"
                  href={item.link_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {item.route_details?.mapUrl
                    ? "Открыть карту"
                    : item.source === "rpm-rent-locations"
                      ? "Подробнее на сайте"
                      : "Открыть маршрут"}{" "}
                  <ArrowUpRight size={17} />
                </a>
              )}
            </div>
          </article>
        ))
      )}
    </>
  );
}
export function WikiScreen({
  conditions = false,
  account,
}: {
  conditions?: boolean;
  account: AccountSnapshot;
}) {
  const r = useResource<{ items: ClubContent[] }>("club/content?kind=wiki");
  const [category, setCategory] = useState("faq"),
    [search, setSearch] = useState("");
  const selected = conditions ? "rules" : category;
  const articles = r.data?.items.filter(
    (item) =>
      (selected === "faq"
        ? ["faq", "general"].includes(item.category)
        : item.category === selected) &&
      (item.title + " " + item.body)
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <h1>{conditions ? "Как работает клуб" : "Wiki и помощь"}</h1>
      {conditions ? (
        <div className="club-conditions">
          <ol>
            <li>Выберите автомобиль и даты в разделе «Аренда».</li>
            <li>Отправьте заявку и дождитесь подтверждения менеджера.</li>
            <li>
              После завершения и оплаты аренда увеличит вашу общую сумму
              поездок.
            </li>
            <li>
              При достижении порога откроется следующий уровень. Достигнутый
              статус сохраняется.
            </li>
          </ol>
          <p>
            Скидка определяется вашей картой и фиксируется при отправке заявки.
            Оплата аренды — на месте.
          </p>
          {account.program.tiers.map((t) => (
            <div className="condition-tier" key={t.code}>
              <strong>{tierName(t)}</strong>
              <span>
                от {money(t.thresholdKopecks)} · {t.rateBps / 100}% скидка
              </span>
              <ul>
                {resolveTierBenefits(account.program.tiers, t.code).map(
                  (benefit) => (
                    <li key={benefit}>{benefit}</li>
                  ),
                )}
              </ul>
            </div>
          ))}
          <p className="small-note">
            Дополнительные привилегии указаны на картах. Их предоставление
            подтвердит менеджер.
          </p>
        </div>
      ) : (
        <>
          <div className="segmented">
            <button
              className={category === "faq" ? "active" : ""}
              onClick={() => setCategory("faq")}
            >
              Частые вопросы
            </button>
            <button
              className={category === "emergency" ? "active" : ""}
              onClick={() => setCategory("emergency")}
            >
              ДТП и помощь
            </button>
          </div>
          <input
            className="wiki-search"
            aria-label="Поиск по Wiki"
            placeholder="Найти ответ"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </>
      )}
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : (
        articles?.map((item) => (
          <details className="wiki-article" key={item.id}>
            <summary>{item.title}</summary>
            <p className="preserve-lines">{item.body}</p>
            {item.link_url && (
              <a
                href={item.link_url}
                target="_blank"
                rel="noreferrer"
                className="text-link"
              >
                Подробнее ↗
              </a>
            )}
          </details>
        ))
      )}
      {r.data && !articles?.length && !conditions && (
        <Empty title={search ? "Ответ не найден" : "Статьи скоро появятся"}>
          Команда RPM поможет с вашим вопросом.
        </Empty>
      )}
      <Link href="/contacts" className="button button-outline button-full">
        Связаться с RPM <ArrowRight size={17} />
      </Link>
    </>
  );
}
