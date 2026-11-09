"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { command, Failure, Loading, useResource } from "@/components/shared";

type Prize = {
  id: string;
  title: string;
  summary: string;
  terms: string;
  image_url: string;
  image_alt: string;
};
type Award = {
  id: string;
  status: string;
  claim_code: string;
  expires_at: string;
  redeemed_at: string | null;
  prize_snapshot: Prize;
};
type State = {
  enabled: boolean;
  attempts: number;
  prizes: Prize[];
  awards: Award[];
  credits: {
    id: string;
    source_type: string;
    granted: number;
    consumed: number;
    expires_at: string;
  }[];
};
type Spin = { spinId: string; prize: Prize; award: Award; attempts: number };
const labels: Record<string, string> = {
  available: "Доступен",
  reserved: "Применён к заявке",
  redeemed: "Использован",
  expired: "Истёк",
};
const sources: Record<string, string> = {
  registration: "За регистрацию",
  promo: "По промокоду",
  manual: "Выдано администратором",
};

export function RouletteScreen() {
  const { data, error, loading, refresh } = useResource<State>("me/roulette");
  const [pending, setPending] = useState(false);
  const [spinError, setSpinError] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [promoMessage, setPromoMessage] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [result, setResult] = useState<Spin | null>(null);
  const [centered, setCentered] = useState(-1);
  const key = useRef<string | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const current = useRef(-1);
  const position = useRef(0);
  const prizeCount = data?.prizes.length ?? 0;
  const prizeIds = data?.prizes.map((prize) => prize.id).join("|") ?? "";

  function centerOn(index: number) {
    const card = track.current?.children.item(index) as HTMLElement | null;
    if (!card || !viewport.current || !track.current) return;
    const offset =
      viewport.current.clientWidth / 2 - card.offsetLeft - card.offsetWidth / 2;
    track.current.style.transform = `translate3d(${offset}px,0,0)`;
    position.current = offset;
    current.current = index;
    setCentered(index);
  }
  useLayoutEffect(() => {
    if (!prizeCount) return;
    const first = prizeCount * 3 + Math.floor(prizeCount / 2);
    centerOn(first);
    const resize = () => {
      if (!track.current?.getAnimations().length)
        centerOn(current.current < 0 ? first : current.current);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [prizeCount, prizeIds]);
  useEffect(() => {
    if (data && location.hash === "#my-awards")
      document.getElementById("my-awards")?.scrollIntoView({ block: "start" });
  }, [data]);

  async function spin() {
    if (pending || !data?.enabled || !data.attempts || !prizeCount) return;
    key.current ??= crypto.randomUUID();
    setPending(true);
    setSpinError("");
    setResult(null);
    try {
      const won = await command<Spin>(
        "me/roulette/spins",
        {},
        "POST",
        key.current,
      );
      key.current = null;
      if (Math.floor(Math.max(0, current.current) / prizeCount) >= 6)
        centerOn(3 * prizeCount + (current.current % prizeCount));
      const prizeIndex = data.prizes.findIndex(
        (prize) => prize.id === won.prize.id,
      );
      const cycle = Math.floor(Math.max(0, current.current) / prizeCount);
      const target = Math.min(
        8 * prizeCount + prizeIndex,
        (cycle + 2) * prizeCount + prizeIndex,
      );
      const card = track.current?.children.item(target) as HTMLElement | null;
      if (card && viewport.current && track.current) {
        const destination =
          viewport.current.clientWidth / 2 -
          card.offsetLeft -
          card.offsetWidth / 2;
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          const animation = track.current.animate(
            [
              { transform: `translate3d(${position.current}px,0,0)` },
              { transform: `translate3d(${destination}px,0,0)` },
            ],
            {
              duration: 4800,
              easing: "cubic-bezier(.12,.75,.13,1)",
              fill: "forwards",
            },
          );
          await animation.finished.catch(() => undefined);
          animation.cancel();
        }
        centerOn(target);
      }
      setResult(won);
      await refresh();
    } catch (cause) {
      setSpinError((cause as Error).message);
    } finally {
      setPending(false);
    }
  }
  if (loading) return <Loading />;
  if (!data)
    return (
      <Failure
        error={error ?? new Error("Не удалось загрузить рулетку")}
        retry={refresh}
      />
    );
  const cards = Array.from({ length: 9 }, (_, cycle) =>
    data.prizes.map((prize) => ({ prize, cycle })),
  ).flat();
  return (
    <div className="roulette-screen">
      {error && <Failure error={error} retry={refresh} />}
      <header className="roulette-heading">
        <span>ГЛАВНАЯ　/　РУЛЕТКА ПРИЗОВ</span>
        <h1>
          Рулетка
          <br />
          <em>призов</em>
        </h1>
        <p>Испытай удачу и получи бонус на аренду</p>
      </header>
      <div className="roulette-frame" ref={viewport}>
        <div className="roulette-pointer" aria-hidden="true" />
        <div
          className="roulette-track"
          ref={track}
          aria-label="Возможные призы"
        >
          {cards.map(({ prize, cycle }, cardIndex) => (
            <article
              key={`${cycle}-${prize.id}`}
              className={`roulette-card${centered === cardIndex ? " is-centered" : ""}${result?.prize.id === prize.id && centered === cardIndex ? " won" : ""}`}
            >
              {prize.image_url ? (
                <img src={prize.image_url} alt={prize.image_alt || ""} />
              ) : (
                <span className="roulette-card-placeholder" aria-hidden="true">
                  RPM
                </span>
              )}
              <div className="roulette-card-copy">
                <span>ПРИЗ RPM CLUB</span>
                <strong>{prize.title}</strong>
              </div>
            </article>
          ))}
        </div>
      </div>
      <div className="roulette-action">
        <button
          className="button roulette-spin-button"
          type="button"
          disabled={!data.enabled || !data.attempts || !prizeCount || pending}
          onClick={spin}
        >
          {pending ? "Рулетка вращается…" : "Крутить рулетку"}
          <span aria-hidden="true">→</span>
        </button>
        <p className="roulette-attempts">
          Доступно прокрутов: <strong>{data.attempts}</strong>
        </p>
        {!data.enabled && (
          <p className="roulette-notice">Розыгрыш пока не открыт.</p>
        )}
        {data.enabled && !data.attempts && (
          <p className="roulette-notice">
            Нет попыток. Получите попытку по промокоду.
          </p>
        )}
        {!prizeCount && (
          <p className="roulette-notice">Сейчас нет доступных призов.</p>
        )}
        {spinError && (
          <div role="alert" className="roulette-error">
            {spinError}
            <button type="button" onClick={spin}>
              Повторить запрос
            </button>
          </div>
        )}
        {result && (
          <p role="status" aria-live="polite" className="roulette-result">
            Ваш приз — <strong>{result.prize.title}</strong>. Он добавлен в «Мои
            призы».
          </p>
        )}
      </div>
      <section className="roulette-promo">
        <h2>Есть промокод?</h2>
        <p>Введите код и получите дополнительный прокрут.</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setRedeeming(true);
            setPromoMessage("");
            try {
              await command(
                "me/roulette/promos/redeem",
                { code: promoCode.trim() },
                "POST",
              );
              setPromoCode("");
              setPromoMessage("Попытка начислена");
              await refresh();
            } catch (cause) {
              setPromoMessage((cause as Error).message);
            } finally {
              setRedeeming(false);
            }
          }}
        >
          <input
            aria-label="Промокод"
            value={promoCode}
            maxLength={80}
            autoComplete="off"
            onChange={(event) => setPromoCode(event.target.value)}
            placeholder="Введите промокод"
          />
          <button type="submit" disabled={redeeming || !promoCode.trim()}>
            {redeeming ? "Проверяем…" : "Применить"}
          </button>
        </form>
        {promoMessage && <p role="status">{promoMessage}</p>}
      </section>
      {!!data.credits?.length && (
        <details className="roulette-credits">
          <summary>История попыток</summary>
          {data.credits.map((credit) => (
            <p key={credit.id}>
              {sources[credit.source_type] ?? credit.source_type}:{" "}
              {credit.granted - credit.consumed} · до{" "}
              {new Date(credit.expires_at).toLocaleString("ru-RU", {
                timeZone: "Europe/Moscow",
              })}{" "}
              МСК
            </p>
          ))}
        </details>
      )}
      <section className="roulette-catalog">
        <h2>Что можно выиграть</h2>
        <div className="roulette-prize-list">
          {data.prizes.map((prize) => (
            <article key={prize.id} className="roulette-prize">
              <div className="roulette-prize-image">
                {prize.image_url && <img src={prize.image_url} alt="" />}
              </div>
              <div>
                <h3>{prize.title}</h3>
                <p>{prize.summary}</p>
                <details>
                  <summary>Условия приза</summary>
                  <p>{prize.terms}</p>
                </details>
              </div>
              <span aria-hidden="true">↗</span>
            </article>
          ))}
        </div>
      </section>
      <section id="my-awards" className="roulette-awards">
        <h2>Активные призы</h2>
        <div className="roulette-award-guide">
          <strong>Как использовать приз</strong>
          <p>
            Выберите автомобиль и даты аренды. В заявке отметьте один приз и
            отправьте её. После завершения аренды приз перейдёт в архив.
          </p>
        </div>
        {data.awards.filter((award) =>
          ["available", "reserved"].includes(award.status),
        ).length ? (
          data.awards
            .filter((award) => ["available", "reserved"].includes(award.status))
            .map((award) => <AwardCard key={award.id} award={award} />)
        ) : (
          <p>Нет активных призов.</p>
        )}
      </section>
      <section className="roulette-awards">
        <h2>Архив призов</h2>
        {data.awards.filter((award) =>
          ["redeemed", "expired"].includes(award.status),
        ).length ? (
          data.awards
            .filter((award) => ["redeemed", "expired"].includes(award.status))
            .map((award) => <AwardCard key={award.id} award={award} />)
        ) : (
          <p>Использованные и истёкшие призы появятся здесь.</p>
        )}
      </section>
    </div>
  );
}

function AwardCard({ award }: { award: Award }) {
  const available = award.status === "available";
  return (
    <article className="roulette-award">
      <div className="roulette-award-heading">
        <strong>{award.prize_snapshot.title}</strong>
        <span>{labels[award.status] ?? award.status}</span>
      </div>
      <p>{award.prize_snapshot.terms}</p>
      <small>
        Действует до{" "}
        {new Date(award.expires_at).toLocaleString("ru-RU", {
          timeZone: "Europe/Moscow",
        })}{" "}
        МСК
      </small>
      {available && (
        <Link className="roulette-activate-link" href="/rent">
          Активировать в аренде <span aria-hidden="true">→</span>
        </Link>
      )}
      {award.redeemed_at && (
        <small>
          Активирован{" "}
          {new Date(award.redeemed_at).toLocaleString("ru-RU", {
            timeZone: "Europe/Moscow",
          })}{" "}
          МСК
        </small>
      )}
    </article>
  );
}
