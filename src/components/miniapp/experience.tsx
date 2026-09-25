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
  Dialog,
  Field,
  FormMessage,
  Spinner,
} from "@/components/shared";
import { date, money } from "@/lib/ui";
import { resolveTierBenefits, tierName } from "@/lib/loyalty/rules";
import type { AccountSnapshot } from "@/lib/loyalty/types";
import {
  moscowDate,
  type ClubContent,
  type RentalRequest,
} from "@/lib/club/contracts";

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
  const [resume, setResume] = useState<BookingDraft | null>(null),
    [resumeError, setResumeError] = useState("");
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("draft");
    if (id)
      void api<BookingDraft>("me/booking-draft?id=" + encodeURIComponent(id))
        .then(setResume)
        .catch((e) => setResumeError(e.message));
  }, []);
  const selectedCar = r.data?.items.find(
    (c) => c.id === (selected?.id ?? resume?.car_id),
  );
  return (
    <>
      <h1>Аренда автомобиля</h1>
      <p className="screen-subtitle">
        Выберите автомобиль и даты. Менеджер подтвердит вашу поездку. Оплата на
        месте.
      </p>
      <FormMessage error={resumeError} />
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
          {r.data.items.map((car) => (
            <article className="catalog-card" key={car.id}>
              {car.image_url ? (
                <img
                  className="content-cover"
                  src={car.image_url}
                  alt={car.title}
                  loading="lazy"
                />
              ) : (
                <div className="content-placeholder">
                  <CarFront size={38} />
                </div>
              )}
              <div className="catalog-body">
                <h2>{car.title}</h2>
                <p>{car.summary}</p>
                <strong>{money(car.daily_price_kopecks)} / сутки</strong>
                {car.available === false && (
                  <p className="small-note">Временно недоступен для аренды</p>
                )}
                <button
                  className="button button-full"
                  disabled={car.available === false}
                  onClick={() => {
                    setResume(null);
                    setSelected(car);
                  }}
                >
                  Выбрать даты
                </button>
              </div>
            </article>
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
          onClose={() => {
            setSelected(null);
            setResume(null);
          }}
          onDone={() => {
            setSelected(null);
            setResume(null);
            setRequestVersion((v) => v + 1);
          }}
        />
      )}
    </>
  );
}
type Quote = {
  dailyPriceKopecks: string;
  days: number;
  grossKopecks: string;
  discountKopecks: string;
  totalKopecks: string;
  discountBps: number;
  carVersion: number;
  programId: string;
};
type BookingDraft = {
  id: string;
  car_id: string;
  start_date: string;
  end_date: string;
  comment: string;
  request_key: string;
};
function BookingDialog({
  car,
  initial,
  onClose,
  onDone,
}: {
  car: ClubContent;
  initial?: BookingDraft | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [today] = useState(() => moscowDate());
  const [start, setStart] = useState(initial?.start_date ?? today),
    [end, setEnd] = useState(
      () => initial?.end_date ?? moscowDate(new Date(Date.now() + 86400000)),
    );
  const [quote, setQuote] = useState<Quote | null>(null),
    [comment, setComment] = useState(initial?.comment ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [key] = useState(() => initial?.request_key ?? crypto.randomUUID());
  const currentQuote = quote?.carVersion === car.version ? quote : null;
  const [draftMessage, setDraftMessage] = useState("");
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      if (start >= today && end >= start && !busy)
        void command("me/booking-draft", {
          carId: car.id,
          startDate: start,
          endDate: end,
          comment,
          requestKey: key,
        })
          .then(() => {
            if (current)
              setDraftMessage(
                "Выбор сохранён. Заявка отправится только после подтверждения.",
              );
          })
          .catch(() => {
            if (current)
              setDraftMessage(
                "Черновик не сохранён. Вы можете отправить заявку обычным способом.",
              );
          });
    }, 600);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [car.id, start, end, comment, key, today, busy]);
  return (
    <Dialog title={car.title} onClose={onClose} busy={busy}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const payload = {
              carId: car.id,
              startDate: start,
              endDate: end,
              comment,
            };
            if (!currentQuote)
              setQuote(await command<Quote>("me/rental-quotes", payload));
            else {
              await command(
                "me/rental-requests",
                {
                  ...payload,
                  expectedTotal: currentQuote.totalKopecks,
                  expectedCarVersion: currentQuote.carVersion,
                  expectedProgramId: currentQuote.programId,
                },
                "POST",
                key,
              );
              onDone();
            }
          } catch (e) {
            setError((e as Error).message);
            setQuote(null);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="small-note">{draftMessage}</p>
        {!!car.image_urls?.length && (
          <div className="catalog-gallery" aria-label="Фотографии автомобиля">
            {car.image_urls.map((image, index) => (
              <img
                key={image.url + index}
                src={image.url}
                alt={image.alt || car.title}
                loading="lazy"
              />
            ))}
          </div>
        )}
        {car.body && <p className="preserve-lines small-note">{car.body}</p>}
        <Field label="Дата начала">
          <input
            type="date"
            disabled={busy}
            min={today}
            value={start}
            required
            onChange={(e) => {
              setStart(e.target.value);
              setQuote(null);
            }}
          />
        </Field>
        <Field label="Дата возврата">
          <input
            type="date"
            disabled={busy}
            min={start}
            value={end}
            required
            onChange={(e) => {
              setEnd(e.target.value);
              setQuote(null);
            }}
          />
        </Field>
        <Field label="Пожелания">
          <textarea
            disabled={busy}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={1000}
            rows={2}
          />
        </Field>
        {currentQuote && (
          <div className="quote-panel">
            <p>
              {currentQuote.days} сут. × {money(currentQuote.dailyPriceKopecks)}
            </p>
            {currentQuote.discountBps > 0 && (
              <p>
                Скидка по карте {currentQuote.discountBps / 100}%: −
                {money(currentQuote.discountKopecks)}
              </p>
            )}
            <strong>Итого: {money(currentQuote.totalKopecks)}</strong>
          </div>
        )}
        <p className="small-note">
          Минимальный срок — {car.minimum_rental_days ?? 1} сут. Заявка не
          гарантирует наличие автомобиля. Выдачу и окончательные условия
          подтвердит менеджер.
        </p>
        <FormMessage error={error} />
        <button
          className="button button-full"
          disabled={busy || car.available === false}
        >
          {busy && <Spinner />}
          {currentQuote ? "Отправить заявку" : "Рассчитать стоимость"}
        </button>
      </form>
    </Dialog>
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
          <span className="eyebrow">{labels[item.status]}</span>
          <h3>{item.car_name}</h3>
          <p>
            {date(item.start_date)} — {date(item.end_date)}
          </p>
          <strong>{money(item.total_kopecks)}</strong>
          {item.discount_bps > 0 && (
            <p className="small-note">Скидка {item.discount_bps / 100}%</p>
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
  const r = useResource<{ items: ClubContent[] }>("club/content?kind=route");
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
            {item.image_url && (
              <img className="content-cover" src={item.image_url} alt="" />
            )}
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
              {item.link_url && (
                <a
                  className="button button-outline button-full"
                  href={item.link_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Открыть маршрут <ArrowUpRight size={17} />
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
