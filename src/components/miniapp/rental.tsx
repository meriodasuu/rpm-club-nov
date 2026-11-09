"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  CarFront,
  Check,
  ChevronLeft,
  ChevronRight,
  Gift,
  Info,
  Plus,
} from "lucide-react";
import {
  ApiError,
  command,
  Dialog,
  Field,
  FormMessage,
  Spinner,
} from "@/components/shared";
import { money } from "@/lib/ui";
import { rentalPriceAdjustments } from "@/lib/roulette/quote";
import { moscowDate, type ClubContent } from "@/lib/club/contracts";
import {
  calendarDays,
  dateLabel,
  shiftDate,
  shiftMonth,
} from "@/lib/club/calendar";

export type BookingDraft = {
  id: string;
  car_id: string;
  start_date: string;
  end_date: string;
  comment: string;
  request_key: string;
};
type Quote = {
  dailyPriceKopecks: string;
  days: number;
  grossKopecks: string;
  discountKopecks: string;
  totalKopecks: string;
  discountBps: number;
  carVersion: number;
  programId: string;
  offerId?: string | null;
  offerVersion?: number | null;
  offerTitle?: string | null;
  offerDiscountBps?: number | null;
  discountSource?: "offer" | "club";
  quoteVersion: string;
  awardDiscountKopecks: string;
  awards: {
    id: string;
    title: string;
    terms?: string;
    claim_code?: string;
    effect_type: string;
    effect_value: number;
    effectKopecks: string;
  }[];
  availableAwards: {
    id: string;
    title: string;
    terms: string;
    claim_code: string;
    effect_type: string;
    effect_value: number;
  }[];
};

export function visibleRentalAwards(
  quote: Pick<Quote, "availableAwards"> | null,
  previous: Quote["availableAwards"],
) {
  return quote ? quote.availableAwards : previous;
}

function carName(car: ClubContent) {
  const brand = car.vehicle_specs?.brand;
  // Retain the full source title when it doesn't start with the separate brand.
  return brand &&
    car.title.toLocaleLowerCase().startsWith(brand.toLocaleLowerCase() + " ")
    ? car.title.slice(brand.length).trim()
    : car.title;
}

function compactTransmission(value: string) {
  if (/[PР]D[KК]/i.test(value)) return "PDK";
  if (/автомат|[tт]r[oо]ni[cс]|АКПП/i.test(value)) return "Автомат";
  if (/механ|МКПП/i.test(value)) return "Механика";
  if (/робот/i.test(value)) return "Робот";
  return value;
}

function compactDrive(value: string) {
  const direction = /^(полный|задний|передний)/i.exec(value)?.[0];
  return direction ? direction + " привод" : value;
}

export function CarGallery({
  car,
  onDetails,
}: {
  car: ClubContent;
  onDetails?: () => void;
}) {
  const images = car.image_urls?.length
    ? car.image_urls
    : car.image_url
      ? [{ url: car.image_url, alt: car.title }]
      : [];
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const active = Math.min(index, Math.max(0, images.length - 1));
  function goTo(next: number) {
    const el = track.current;
    el?.scrollTo({ left: next * el.clientWidth, behavior: "smooth" });
  }
  if (!images.length)
    return (
      <div className="car-photo-placeholder">
        <CarFront size={42} />
      </div>
    );
  return (
    <div
      className="car-gallery"
      role="region"
      aria-label={`Фотографии: ${car.title}`}
    >
      <div
        ref={track}
        className="car-photo-track"
        onScroll={(e) => {
          const el = e.currentTarget;
          setIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
        }}
      >
        {images.map((image, i) => (
          <button
            type="button"
            className="car-photo"
            key={image.url + i}
            onClick={onDetails}
            tabIndex={i === active ? 0 : -1}
            aria-label={
              onDetails
                ? `Подробнее об автомобиле ${car.title}`
                : `Фото ${i + 1}: ${car.title}`
            }
          >
            <img src={image.url} alt={image.alt || car.title} loading="lazy" />
          </button>
        ))}
      </div>
      {images.length > 1 && (
        <>
          <span className="car-photo-counter">
            {active + 1} / {images.length}
          </span>
          <div className="car-photo-dots" aria-hidden="true">
            {Array.from({ length: Math.min(5, images.length) }, (_, i) => (
              <i
                className={
                  i ===
                  Math.round(
                    (active * (Math.min(5, images.length) - 1)) /
                      (images.length - 1),
                  )
                    ? "active"
                    : ""
                }
                key={i}
              />
            ))}
          </div>
          <button
            type="button"
            className="car-photo-arrow previous"
            aria-label="Предыдущее фото"
            disabled={active === 0}
            onClick={() => goTo(active - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            className="car-photo-arrow next"
            aria-label="Следующее фото"
            disabled={active === images.length - 1}
            onClick={() => goTo(active + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </>
      )}
    </div>
  );
}

export function CarCard({
  car,
  onBook,
}: {
  car: ClubContent;
  onBook: () => void;
}) {
  const [details, setDetails] = useState(false);
  const specs = car.vehicle_specs;
  const facts = [
    specs?.year && String(specs.year),
    specs?.transmission && compactTransmission(specs.transmission),
    specs?.driveType && compactDrive(specs.driveType),
  ].filter(Boolean);
  const bookButton = (
    <button
      type="button"
      className="button car-book-button"
      disabled={car.available === false}
      onClick={() => {
        setDetails(false);
        onBook();
      }}
    >
      Выбрать даты <ArrowRight size={17} />
    </button>
  );
  return (
    <>
      <article className="car-card">
        <CarGallery car={car} onDetails={() => setDetails(true)} />
        <div className="car-card-body">
          <button
            type="button"
            className="car-title-button"
            onClick={() => setDetails(true)}
          >
            {specs?.brand && <span className="car-brand">{specs.brand}</span>}
            <h2>{carName(car)}</h2>
          </button>
          {!!facts.length && (
            <ul className="car-facts">
              {facts.map((fact, i) => (
                <li key={i}>{fact}</li>
              ))}
            </ul>
          )}
          <div className="car-card-footer">
            <div className="car-price">
              <strong>{money(car.daily_price_kopecks)}</strong>
              <span>за сутки</span>
            </div>
            {bookButton}
          </div>
          <p className="car-payment">
            {car.available === false
              ? "Временно недоступен для аренды"
              : "Оплата на месте"}
          </p>
        </div>
      </article>
      {details && (
        <Dialog title={car.title} onClose={() => setDetails(false)}>
          <CarGallery car={car} />
          <p className="car-detail-copy preserve-lines">{car.summary}</p>
          <p className="car-detail-copy preserve-lines">{car.body}</p>
          <div className="car-card-footer">
            <div className="car-price">
              <strong>{money(car.daily_price_kopecks)}</strong>
              <span>за сутки</span>
            </div>
            {bookButton}
          </div>
        </Dialog>
      )}
    </>
  );
}

function RentalCalendar({
  start,
  end,
  today,
  minimumDays,
  busy,
  onChange,
}: {
  start: string;
  end: string;
  today: string;
  minimumDays: number;
  busy: boolean;
  onChange: (start: string, end: string) => void;
}) {
  const [field, setField] = useState<"start" | "end">("start");
  const [month, setMonth] = useState(start.slice(0, 7) + "-01");
  const lastStart = shiftDate(today, 365);
  const min = field === "start" ? today : shiftDate(start, minimumDays);
  const max = field === "start" ? lastStart : shiftDate(start, 90);
  return (
    <>
      <div
        className="rental-date-fields"
        role="group"
        aria-label="Период аренды"
      >
        {(["start", "end"] as const).map((kind) => (
          <button
            type="button"
            key={kind}
            className={field === kind ? "active" : ""}
            disabled={busy}
            aria-pressed={field === kind}
            onClick={() => {
              setField(kind);
              setMonth((kind === "start" ? start : end).slice(0, 7) + "-01");
            }}
          >
            <span>{kind === "start" ? "Начало аренды" : "Возврат"}</span>
            <strong>
              {dateLabel(kind === "start" ? start : end, {
                day: "numeric",
                month: "short",
              })}
            </strong>
            <CalendarDays size={20} />
          </button>
        ))}
      </div>
      <section className="rental-calendar" aria-label="Календарь аренды">
        <div className="rental-month">
          <button
            type="button"
            aria-label="Предыдущий месяц"
            disabled={busy || month.slice(0, 7) <= min.slice(0, 7)}
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            <ChevronLeft size={22} />
          </button>
          <h3 aria-live="polite">
            {dateLabel(month, { month: "long", year: "numeric" }).replace(
              " г.",
              "",
            )}
          </h3>
          <button
            type="button"
            aria-label="Следующий месяц"
            disabled={busy || month.slice(0, 7) >= max.slice(0, 7)}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            <ChevronRight size={22} />
          </button>
        </div>
        <div className="rental-weekdays" aria-hidden="true">
          {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div
          className="rental-days"
          role="group"
          aria-label={
            field === "start"
              ? "Выберите дату начала"
              : "Выберите дату возврата"
          }
        >
          {calendarDays(month).map((day, i) =>
            day ? (
              <button
                type="button"
                key={day}
                disabled={busy || day < min || day > max}
                aria-label={dateLabel(day, {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
                aria-pressed={day === start || day === end}
                className={[
                  day === start ? "range-start" : "",
                  day === end ? "range-end" : "",
                  day > start && day < end ? "in-range" : "",
                ].join(" ")}
                onClick={() => {
                  if (field === "start") {
                    const earliest = shiftDate(day, minimumDays);
                    const nextEnd =
                      end < earliest || end > shiftDate(day, 90)
                        ? earliest
                        : end;
                    onChange(day, nextEnd);
                    setField("end");
                    setMonth(nextEnd.slice(0, 7) + "-01");
                  } else onChange(start, day);
                }}
              >
                {Number(day.slice(-2))}
              </button>
            ) : (
              <span key={`empty-${i}`} />
            ),
          )}
        </div>
        <p className="rental-calendar-note">
          <Info size={17} />
          Время получения согласует менеджер
        </p>
        {minimumDays > 1 && (
          <p className="rental-minimum">
            Минимальный срок — {minimumDays} сут.
          </p>
        )}
      </section>
    </>
  );
}

export function BookingDialog({
  car,
  initial,
  offer,
  onClose,
  onDone,
}: {
  car: ClubContent;
  initial?: BookingDraft | null;
  offer?: {
    id: string;
    title: string;
    discount_bps: number;
    version: number;
  } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [today] = useState(() => moscowDate());
  const minimumDays = car.minimum_rental_days ?? 1;
  const [start, setStart] = useState(
    initial?.start_date &&
      initial.start_date >= today &&
      initial.start_date <= shiftDate(today, 365)
      ? initial.start_date
      : today,
  );
  const [end, setEnd] = useState(() =>
    initial?.end_date &&
    initial.end_date >= shiftDate(start, minimumDays) &&
    initial.end_date <= shiftDate(start, 90)
      ? initial.end_date
      : shiftDate(start, minimumDays),
  );
  const [comment, setComment] = useState(initial?.comment ?? "");
  const [awardIds, setAwardIds] = useState<string[]>([]);
  const [availableAwards, setAvailableAwards] = useState<
    Quote["availableAwards"]
  >([]);
  const [awardNotice, setAwardNotice] = useState("");
  const [showComment, setShowComment] = useState(!!initial?.comment);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [draftError, setDraftError] = useState("");
  const [retry, setRetry] = useState(0);
  const [key] = useState(() => initial?.request_key ?? crypto.randomUUID());
  const [result, setResult] = useState<{
    signature: string;
    quote?: Quote;
    error?: string;
  } | null>(null);
  const signature = `${car.id}:${car.version}:${start}:${end}:${awardIds.join(",")}:${retry}`;
  const currentResult = result?.signature === signature ? result : null;
  const offerId = offer?.id;
  const quote =
    currentResult?.quote?.carVersion === car.version
      ? currentResult.quote
      : null;
  const sending = useRef(false);

  useEffect(() => {
    if (submitted) return;
    let current = true;
    const timer = setTimeout(() => {
      void command<Quote>("me/rental-quotes", {
        carId: car.id,
        startDate: start,
        endDate: end,
        awardIds,
        ...(offerId ? { offerId } : {}),
      })
        .then((value) => {
          if (current) {
            setResult({ signature, quote: value });
            setAvailableAwards(value.availableAwards);
          }
        })
        .catch((e: Error) => {
          if (current) {
            setResult({ signature, error: e.message });
            if (
              e instanceof ApiError &&
              e.code === "AWARD_UNAVAILABLE" &&
              awardIds.length
            ) {
              setAwardNotice(
                "Список призов обновлён. Выберите доступный приз.",
              );
              setAwardIds([]);
            }
          }
        });
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [car.id, signature, start, end, submitted, offerId, awardIds]);

  useEffect(() => {
    if (submitted || busy) return;
    let current = true;
    const timer = setTimeout(() => {
      void command("me/booking-draft", {
        carId: car.id,
        startDate: start,
        endDate: end,
        comment,
        requestKey: key,
      })
        .then(() => {
          if (current) setDraftError("");
        })
        .catch(() => {
          if (current)
            setDraftError(
              "Не удалось сохранить черновик. Заявку можно отправить ниже.",
            );
        });
    }, 600);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [car.id, start, end, comment, key, busy, submitted]);

  return (
    <Dialog
      title={submitted ? "Заявка отправлена" : "Выбор дат"}
      fullScreen
      onClose={submitted ? onDone : onClose}
      busy={busy}
    >
      {submitted ? (
        <div className="rental-success">
          <div className="rental-success-icon">
            <Check size={32} />
          </div>
          <h3>{car.title}</h3>
          <p>
            {dateLabel(start, { day: "numeric", month: "long" })} —{" "}
            {dateLabel(end, { day: "numeric", month: "long" })}
          </p>
          <p>Менеджер свяжется с вами и подтвердит аренду.</p>
          <button type="button" className="button button-full" onClick={onDone}>
            Мои заявки <ArrowRight size={18} />
          </button>
        </div>
      ) : (
        <form
          className="rental-booking-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!quote || sending.current || car.available === false) return;
            sending.current = true;
            setBusy(true);
            setError("");
            try {
              await command(
                "me/rental-requests",
                {
                  carId: car.id,
                  startDate: start,
                  endDate: end,
                  comment,
                  expectedTotal: quote.totalKopecks,
                  expectedCarVersion: quote.carVersion,
                  expectedProgramId: quote.programId,
                  expectedQuoteVersion: quote.quoteVersion,
                  awardIds,
                  ...(offer
                    ? {
                        offerId: offer.id,
                        expectedOfferVersion: quote.offerVersion,
                      }
                    : {}),
                },
                "POST",
                key,
              );
              setSubmitted(true);
            } catch (e) {
              setError((e as Error).message);
              setRetry((v) => v + 1);
            } finally {
              sending.current = false;
              setBusy(false);
            }
          }}
        >
          {offer && (
            <div className="offer-booking-note">
              <strong>{offer.title}</strong>
              <span>Специальная цена предложения будет учтена в расчёте.</span>
            </div>
          )}
          <div className="rental-car-summary">
            {car.image_url ? (
              <img src={car.image_url} alt={car.title} />
            ) : (
              <CarFront size={32} />
            )}
            <div>
              {car.vehicle_specs?.brand && (
                <span className="car-brand">{car.vehicle_specs.brand}</span>
              )}
              <h3>{carName(car)}</h3>
              <p>{money(car.daily_price_kopecks)} / сутки</p>
            </div>
          </div>
          <RentalCalendar
            start={start}
            end={end}
            today={today}
            minimumDays={minimumDays}
            busy={busy}
            onChange={(from, to) => {
              setStart(from);
              setEnd(to);
              setError("");
            }}
          />
          {!offer && !!visibleRentalAwards(quote, availableAwards).length && (
            <section
              className="rental-prize-picker"
              aria-label="Призы для этой аренды"
            >
              <div className="rental-prize-heading">
                <span className="rental-prize-icon" aria-hidden="true">
                  <Gift size={18} />
                </span>
                <div>
                  <h3>Призы</h3>
                  <p>К аренде можно применить один приз вместо скидки по карте</p>
                </div>
              </div>
              <div className="rental-prize-list">
                <article
                  className={`rental-prize-option${awardIds.length ? "" : " selected"}`}
                >
                  <label>
                    <input
                      type="radio"
                      name="rental-award"
                      checked={!awardIds.length}
                      disabled={busy}
                      onChange={() => {
                        setAwardNotice("");
                        setAwardIds([]);
                      }}
                    />
                    <span className="rental-prize-copy">
                      <span className="rental-prize-title">Без приза</span>
                    </span>
                  </label>
                </article>
                {visibleRentalAwards(quote, availableAwards).map((award) => {
                  const selected = awardIds.includes(award.id);
                  const benefit =
                    award.effect_type === "percent"
                      ? `−${award.effect_value / 100}%`
                      : award.effect_type === "free_day"
                        ? `${award.effect_value} сут.`
                        : award.effect_type === "fixed"
                          ? "Скидка"
                          : award.effect_type === "wash"
                            ? "Мойка"
                            : award.effect_type === "upgrade"
                              ? "Улучшение"
                              : award.effect_type === "bonus"
                                ? "Бонусы"
                                : "Подарок";
                  return (
                    <article
                      className={`rental-prize-option${selected ? " selected" : ""}`}
                      key={award.id}
                    >
                      <label>
                        <input
                          type="radio"
                          name="rental-award"
                          checked={selected}
                          disabled={busy}
                          onChange={(event) => {
                            setAwardNotice("");
                            if (event.target.checked) setAwardIds([award.id]);
                          }}
                        />
                        <span className="rental-prize-copy">
                          <span className="rental-prize-title">
                            {award.title}
                          </span>
                        </span>
                        <span className="rental-prize-benefit">{benefit}</span>
                      </label>
                      {award.terms && (
                        <details className="rental-prize-terms">
                          <summary>Условия приза</summary>
                          <p>{award.terms}</p>
                        </details>
                      )}
                    </article>
                  );
                })}
              </div>
              {awardNotice && (
                <p className="rental-prize-note" role="status">
                  {awardNotice}
                </p>
              )}
              <p className="rental-prize-note">
                Выбранный приз заменяет скидку по карте и будет виден менеджеру в заявке.
              </p>
            </section>
          )}
          <div
            className="rental-total"
            aria-live="polite"
            aria-busy={!currentResult}
          >
            {quote ? (
              <>
                <div>
                  <span>
                    {money(quote.dailyPriceKopecks)} × {quote.days} сут.
                  </span>
                  <span>{money(quote.grossKopecks)}</span>
                </div>
                {quote.discountBps > 0 && (
                  <div className="rental-discount">
                    <span>
                      {offer && quote.discountSource === "offer"
                        ? `Скидка по предложению ${quote.discountBps / 100}%`
                        : offer
                          ? `Применена большая скидка ${quote.discountBps / 100}%`
                          : `Скидка по карте ${quote.discountBps / 100}%`}
                    </span>
                    <span>−{money(quote.discountKopecks)}</span>
                  </div>
                )}
                {rentalPriceAdjustments(quote.awards).map((award, index) => (
                  <div className="rental-discount" key={award.id}>
                    <span>
                      Приз {index + 1}: {award.title}
                      {award.effect_type === "percent"
                        ? ` (${award.effect_value / 100}%)`
                        : ""}
                    </span>
                    <span>−{money(award.effectKopecks)}</span>
                  </div>
                ))}
                <div className="rental-total-amount">
                  <strong>Итого</strong>
                  <strong>{money(quote.totalKopecks)}</strong>
                </div>
              </>
            ) : currentResult?.error ? (
              <>
                <FormMessage error={currentResult.error} />
                <button
                  type="button"
                  className="text-link"
                  onClick={() => setRetry((v) => v + 1)}
                >
                  Повторить расчёт
                </button>
              </>
            ) : (
              <p className="rental-calculating">
                <Spinner /> Рассчитываем стоимость…
              </p>
            )}
          </div>
          <div className="rental-comment">
            <button
              type="button"
              className="rental-comment-toggle"
              aria-expanded={showComment}
              disabled={busy}
              onClick={() => setShowComment((v) => !v)}
            >
              <Plus size={21} />
              {showComment ? "Комментарий к заявке" : "Добавить комментарий"}
              <ChevronRight size={19} />
            </button>
            {showComment && (
              <Field label="Пожелания">
                <textarea
                  autoFocus
                  value={comment}
                  disabled={busy}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder="Например, удобное время получения"
                />
              </Field>
            )}
          </div>
          {draftError && (
            <p className="small-note" role="status">
              {draftError}
            </p>
          )}
          <FormMessage error={error} />
          <div className="rental-submit">
            <button
              className="button button-full"
              disabled={busy || !quote || car.available === false}
            >
              {busy && <Spinner />}Отправить заявку
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
