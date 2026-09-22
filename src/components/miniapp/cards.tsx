"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Check } from "lucide-react";
import type { AccountSnapshot } from "@/lib/loyalty/types";
import {
  resolveTierBenefits,
  tierColor,
  tierName,
  type TierRule,
} from "@/lib/loyalty/rules";
import { money } from "@/lib/ui";

export function MembershipCard({
  account,
  tier,
}: {
  account: AccountSnapshot;
  tier?: TierRule;
}) {
  const current =
    tier ?? account.program.tiers.find((t) => t.code === account.tier)!;
  const own = current.code === account.tier;
  return (
    <section
      className={"membership-card color-" + tierColor(current)}
      aria-label={"Карта RPM " + tierName(current)}
    >
      <div className="card-top">
        <b className="card-rpm">RPM</b>
        <span>
          MEMBERSHIP
          <br />
          RPM RENT
        </span>
      </div>
      <div className="card-middle">
        <span className="card-tier">{tierName(current)}</span>
        <span className="card-name">
          {own ? account.user.name : "Карта участника клуба"}
        </span>
        <small>
          {own ? "ВАША КАРТА" : "ОТ " + money(current.thresholdKopecks)}
        </small>
      </div>
      <div className="card-bottom">
        <span className="member-id">
          {own ? "ID  " + account.user.public_member_id : "RPM CLUB"}
        </span>
        <div className="card-bonus">
          <strong>{current.rateBps / 100}%</strong>
          <span>СКИДКА</span>
        </div>
      </div>
    </section>
  );
}
export function CardCarousel({ account }: { account: AccountSnapshot }) {
  const tiers = account.program.tiers,
    currentIndex = Math.max(
      0,
      tiers.findIndex((t) => t.code === account.tier),
    );
  const [selected, setSelected] = useState(currentIndex),
    track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = track.current?.children[currentIndex] as
      HTMLElement | undefined;
    if (element && track.current)
      track.current.scrollLeft =
        element.offsetLeft -
        (track.current.children[0] as HTMLElement).offsetLeft;
  }, [currentIndex]);
  function select(index: number) {
    const element = track.current?.children[index] as HTMLElement | undefined;
    if (!element || !track.current) return;
    track.current.scrollTo({
      left:
        element.offsetLeft -
        (track.current.children[0] as HTMLElement).offsetLeft,
      behavior: "smooth",
    });
    setSelected(index);
  }
  const visible = tiers[selected] ?? tiers[currentIndex];
  const benefits = resolveTierBenefits(tiers, visible.code);
  return (
    <section className="card-carousel" aria-label="Карты и привилегии клуба">
      <div
        className="card-track"
        ref={track}
        onScroll={(e) => {
          const element = e.currentTarget,
            width =
              ((element.children[1] as HTMLElement | undefined)?.offsetLeft ??
                0) -
              ((element.children[0] as HTMLElement | undefined)?.offsetLeft ??
                0);
          if (width > 0)
            setSelected(
              Math.min(
                tiers.length - 1,
                Math.max(0, Math.round(element.scrollLeft / width)),
              ),
            );
        }}
      >
        {tiers.map((tier) => (
          <div className="card-slide" key={tier.code}>
            <MembershipCard account={account} tier={tier} />
          </div>
        ))}
      </div>
      <div className="card-controls">
        <button
          className="icon-button"
          aria-label="Предыдущая карта"
          disabled={selected === 0}
          onClick={() => select(selected - 1)}
        >
          <ChevronLeft size={20} />
        </button>
        <div className="card-dots">
          {tiers.map((tier, i) => (
            <button
              key={tier.code}
              className={selected === i ? "active" : ""}
              aria-label={"Карта " + tierName(tier)}
              aria-pressed={selected === i}
              onClick={() => select(i)}
            />
          ))}
        </div>
        <button
          className="icon-button"
          aria-label="Следующая карта"
          disabled={selected === tiers.length - 1}
          onClick={() => select(selected + 1)}
        >
          <ChevronRight size={20} />
        </button>
      </div>
      <div className="card-details">
        <div>
          <strong>{tierName(visible)}</strong>
          <span>
            {visible.code === account.tier ? "Ваша карта · " : ""}
            От {money(visible.thresholdKopecks)} суммы аренд
          </span>
        </div>
        <ul>
          {benefits.map((benefit) => (
            <li key={benefit}>
              <Check size={15} />
              {benefit}
            </li>
          ))}
        </ul>
      </div>
      {visible.code === account.tier ? (
        <TierProgress account={account} />
      ) : (
        <button className="text-link" onClick={() => select(currentIndex)}>
          К моей карте · {tierName(tiers[currentIndex])}
        </button>
      )}
    </section>
  );
}

function TierProgress({ account }: { account: AccountSnapshot }) {
  const current = account.program.tiers.find(
    (tier) => tier.code === account.tier,
  )!;
  const next = account.program.tiers.find(
    (tier) => tier.code === account.next_tier,
  );
  return (
    <section className="tier-progress" aria-label="Ваш уровень и прогресс">
      <div>
        <span>Ваш уровень</span>
        <strong>{tierName(current)}</strong>
      </div>
      {next ? (
        <>
          <div>
            <span>До {tierName(next)} осталось</span>
            <strong>{money(account.remaining_amount ?? "0")}</strong>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-label={"Прогресс до " + tierName(next)}
            aria-valuenow={Math.round(account.progress_percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: account.progress_percent + "%" }} />
          </div>
        </>
      ) : (
        <p className="small-note">Вы достигли максимального уровня клуба.</p>
      )}
      <div className="progress-caption">
        <span>Сумма аренд</span>
        <span>{money(account.total_rental_amount)}</span>
      </div>
    </section>
  );
}
