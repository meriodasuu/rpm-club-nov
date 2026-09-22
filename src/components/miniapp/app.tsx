"use client";
import {
  awardStatusLabels,
  type ReferralProgram,
  type ReferralAward,
} from "@/lib/referrals/contracts";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Home,
  Layers3,
  Clock3,
  UserRound,
  Gift,
  Check,
  Copy,
  Send,
  LogOut,
  CarFront,
} from "lucide-react";
import { CardCarousel } from "./cards";
export { MembershipCard } from "./cards";
import {
  ClubLinks,
  RentalScreen,
  RentalRequests,
  RoutesScreen,
  WikiScreen,
} from "./experience";
import { tierName } from "@/lib/loyalty/rules";
import type { AccountSnapshot } from "@/lib/loyalty/types";
import { money, date, labels } from "@/lib/ui";
import {
  Brand,
  Loading,
  Failure,
  Empty,
  FormMessage,
  TierBadge,
  command,
  useResource,
} from "@/components/shared";

type Account = AccountSnapshot & {
  links: { catalog: string; support: string };
  staff_access?: boolean;
};
type Offer = {
  id: string;
  title: string;
  subtitle: string;
  car_name: string;
  image_url: string;
  description: string;
  old_price: string | null;
  new_price: string | null;
  minimum_tier: string;
  start_at: string;
  end_at: string;
  cta_text: string;
  cta_url: string;
};
const navigation = [
  { href: "/home", label: "Главная", icon: Home },
  { href: "/club", label: "Club", icon: Layers3 },
  { href: "/history", label: "История", icon: Clock3 },
  { href: "/profile", label: "Профиль", icon: UserRound },
];
function track(name: string, entityId?: string) {
  void command("analytics", {
    eventId: crypto.randomUUID(),
    name,
    entityId,
  }).catch(() => undefined);
}

export function MiniApp({
  screen,
}: {
  screen:
    | "home"
    | "club"
    | "history"
    | "profile"
    | "rent"
    | "routes"
    | "wiki"
    | "conditions";
}) {
  const {
    data: account,
    error,
    loading,
    refresh,
  } = useResource<Account>("me", 30000);
  const pathname = usePathname();
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tg?.ready();
    tg?.expand();
    if (tg?.initData) tg.BackButton.hide();
  }, []);
  if (loading)
    return (
      <div className="mini-shell">
        <Loading />
      </div>
    );
  if (error || !account)
    return (
      <div className="mini-shell">
        <Failure error={error ?? new Error("Нет данных")} retry={refresh} />
      </div>
    );
  return (
    <div className="mini-backdrop">
      <main className="mini-shell">
        <header className="mini-header">
          <Link href="/home" aria-label="RPM Club — Главная">
            <Brand />
          </Link>
          <Link href="/profile" className="avatar" aria-label="Профиль">
            {account.user.name.slice(0, 1)}
          </Link>
        </header>
        <div className="mini-content">
          {["rent", "routes", "wiki", "conditions"].includes(screen) && (
            <Link className="mini-back-link" href="/home">
              ← На главную
            </Link>
          )}
          {screen === "rent" && <RentalScreen />}
          {screen === "routes" && <RoutesScreen />}
          {(screen === "wiki" || screen === "conditions") && (
            <WikiScreen
              conditions={screen === "conditions"}
              account={account}
              support={account.links.support}
            />
          )}
          {screen === "home" && <HomeScreen account={account} />}
          {screen === "club" && <ClubScreen account={account} />}
          {screen === "history" && <HistoryScreen />}
          {screen === "profile" && (
            <ProfileScreen account={account} refresh={refresh} />
          )}
        </div>
        <nav className="bottom-nav" aria-label="Основная навигация">
          {navigation.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={pathname === n.href ? "page" : undefined}
              className={pathname === n.href ? "active" : ""}
            >
              <n.icon size={23} strokeWidth={1.65} />
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>
      </main>
    </div>
  );
}
function HomeScreen({ account }: { account: Account }) {
  const { data: offers } = useResource<{ items: Offer[] }>("offers");
  return (
    <>
      <h1 className="home-title">Ваш статус внутри RPM</h1>
      <CardCarousel account={account} />
      {account.total_rental_amount === "0" && (
        <p className="small-note" style={{ marginTop: 18 }}>
          Аренд пока нет. Завершённые оплаченные поездки приближают следующий
          уровень.
        </p>
      )}
      <div className="home-actions">
        <Link className="button button-wide" href="/rent">
          Выбрать автомобиль
          <ArrowRight size={22} />
        </Link>
      </div>
      <ClubLinks />
      {offers?.items[0] && <OfferCard offer={offers.items[0]} />}
      {account.next_tier && (
        <div className="next-benefit">
          <div className="benefit-icon">
            <Gift size={20} />
          </div>
          <div>
            <span>
              Следующий уровень ·{" "}
              {tierName(
                account.program.tiers.find(
                  (tier) => tier.code === account.next_tier,
                )!,
              )}
            </span>
            <p>
              {
                account.program.tiers.find((t) => t.code === account.next_tier)
                  ?.benefits[0]
              }
            </p>
          </div>
          <ChevronRight size={18} />
        </div>
      )}
      <div className="mini-note">Ваш статус. Ваши возможности. Ваш RPM.</div>
    </>
  );
}
function OfferCard({ offer }: { offer: Offer }) {
  return (
    <Link
      href={"/offers/" + offer.id}
      className="offer-card"
      onClick={() => track("offer_viewed", offer.id)}
    >
      <img
        src={offer.image_url || "/images/taycan.png"}
        alt={offer.car_name || offer.title}
      />
      <div className="offer-content">
        <span className="offer-label">
          <b>RPM</b> DROP
        </span>
        <div>
          <h3>{offer.subtitle || offer.title}</h3>
          <p>{offer.car_name}</p>
        </div>
        <span className="offer-link">
          Подробнее <ArrowRight size={17} />
        </span>
      </div>
    </Link>
  );
}
function ClubScreen({ account }: { account: Account }) {
  const { data: offers } = useResource<{ items: Offer[] }>("offers");
  return (
    <>
      <h1>RPM Club</h1>
      <p className="screen-subtitle">Каждая поездка открывает больше</p>
      <CardCarousel account={account} />
      <ClubLinks />
      {!!offers?.items.length && (
        <section className="club-offers">
          <h2>Доступно участникам</h2>
          {offers.items.map((o) => (
            <OfferCard key={o.id} offer={o} />
          ))}
        </section>
      )}
      <p className="small-note">
        Достигнутый статус сохраняется. Предоставление привилегий и наличие
        автомобиля подтвердит менеджер RPM.
      </p>
    </>
  );
}
function HistoryScreen() {
  const [tab, setTab] = useState<"rentals" | "transactions" | "requests">(
    "rentals",
  );
  return (
    <>
      <h1>История</h1>
      <div className="segmented" role="tablist" aria-label="Вид истории">
        <button
          role="tab"
          aria-selected={tab === "rentals"}
          onClick={() => setTab("rentals")}
        >
          Аренды
        </button>
        <button
          role="tab"
          aria-selected={tab === "transactions"}
          onClick={() => setTab("transactions")}
        >
          Bonus
        </button>
        <button
          role="tab"
          aria-selected={tab === "requests"}
          onClick={() => setTab("requests")}
        >
          Заявки
        </button>
      </div>
      {tab === "requests" ? (
        <RentalRequests />
      ) : (
        <HistoryList key={tab} tab={tab} />
      )}
    </>
  );
}
function HistoryList({ tab }: { tab: "rentals" | "transactions" }) {
  const [cursor, setCursor] = useState<string | null>(null),
    [previous, setPrevious] = useState<Record<string, unknown>[]>([]);
  const { data, error, loading, refresh } = useResource<{
    items: Record<string, unknown>[];
    nextCursor: string | null;
  }>(
    `me/${tab}?limit=20${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
  );
  if (error) return <Failure error={error} retry={refresh} />;
  if (loading) return <Loading />;
  const items = [...previous, ...(data?.items ?? [])];
  if (!items.length)
    return (
      <Empty
        title={
          tab === "rentals"
            ? "Аренд пока нет"
            : "История Bonus начинается здесь"
        }
      >
        После завершённой аренды здесь появятся ваши операции.
      </Empty>
    );
  return (
    <div className="history-list">
      {items.map((row) => (
        <article className="history-row" key={String(row.id)}>
          {tab === "rentals" ? (
            <div className="car-thumb">
              <CarFront size={22} aria-hidden="true" />
            </div>
          ) : (
            <div
              className={
                "transaction-symbol " +
                (BigInt(String(row.amount ?? 0)) > 0n ? "positive" : "")
              }
            >
              <Gift size={20} />
            </div>
          )}
          <div className="history-info">
            <strong>
              {tab === "rentals"
                ? String(row.car_name)
                : (labels[String(row.type)] ?? String(row.type))}
            </strong>
            <span>
              {tab === "rentals"
                ? `${date(String(row.start_date))} — ${date(String(row.end_date))}`
                : date(String(row.created_at))}
            </span>
            {tab === "transactions" && row.reason ? (
              <small>
                {String(row.reason) === "opening_balance"
                  ? "Перенос подтверждённого остатка"
                  : String(row.reason)}
              </small>
            ) : null}
            {tab === "transactions" &&
            row.expires_at &&
            BigInt(String(row.remaining_amount ?? 0)) > 0n ? (
              <small>
                Остаток {money(String(row.remaining_amount), false)} · до{" "}
                {date(String(row.expires_at))}
              </small>
            ) : null}
          </div>
          <div className="history-amount">
            <strong>
              {tab === "rentals"
                ? money(
                    String(row.current_amount_kopecks ?? row.amount_kopecks),
                  )
                : (BigInt(String(row.amount ?? 0)) > 0n ? "+" : "") +
                  money(String(row.amount ?? 0), false)}
            </strong>
            <span
              className={
                tab === "transactions" && BigInt(String(row.amount ?? 0)) > 0n
                  ? "positive"
                  : ""
              }
            >
              {tab === "rentals"
                ? (labels[String(row.status)] ?? String(row.status))
                : "Bonus"}
            </span>
          </div>
        </article>
      ))}
      {data?.nextCursor && (
        <button
          className="button button-outline button-wide"
          onClick={() => {
            setPrevious(items);
            setCursor(data.nextCursor);
          }}
        >
          Показать ещё
        </button>
      )}
    </div>
  );
}
function ProfileScreen({
  account,
  refresh,
}: {
  account: Account;
  refresh: () => Promise<void>;
}) {
  const router = useRouter();
  const { data: referral, error: referralError } = useResource<{
    code: string;
    url: string | null;
    items: { id: string; status: string }[];
    program: ReferralProgram | null;
    awards: ReferralAward[];
  }>("me/referral");
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  async function invite() {
    if (referral) {
      await navigator.clipboard.writeText(referral.url ?? referral.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  }
  async function marketing(value: boolean) {
    try {
      await command("me/preferences", { marketingConsent: value }, "PATCH");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <h1>Ваш профиль</h1>
      <div className="profile-summary">
        <span className="avatar avatar-large">
          {account.user.name.slice(0, 1)}
        </span>
        <h2>{account.user.name}</h2>
        <TierBadge
          tier={account.tier}
          label={tierName(
            account.program.tiers.find((tier) => tier.code === account.tier)!,
          )}
        />
        <span className="muted">С нами с {date(account.member_since)}</span>
      </div>
      <dl className="profile-details">
        <div>
          <dt>Member ID</dt>
          <dd>{account.user.public_member_id}</dd>
        </div>
        <div>
          <dt>Телефон</dt>
          <dd>{account.user.phone ?? "Не указан"}</dd>
        </div>
        <div>
          <dt>Telegram</dt>
          <dd>
            {account.user.telegram_username
              ? "@" + account.user.telegram_username
              : "Подключён"}
          </dd>
        </div>
        <div>
          <dt>Сумма аренд в RPM</dt>
          <dd>{money(account.total_rental_amount)}</dd>
        </div>
        <div>
          <dt>
            {account.program.rewardMode === "discount"
              ? "Скидка по карте"
              : "Cashback по карте"}
          </dt>
          <dd>
            {(account.program.rewardMode === "discount"
              ? account.discount_rate_bps
              : account.cashback_rate_bps) / 100}
            %
          </dd>
        </div>
        <div>
          <dt>Доступно Bonus</dt>
          <dd>{money(account.bonus_available, false)}</dd>
        </div>
      </dl>
      <div style={{ textAlign: "center", margin: "25px 0" }}>
        <img
          src="/api/me/qr"
          alt="QR карты участника для сотрудника RPM"
          width={160}
          height={160}
          style={{ display: "block", margin: "0 auto 12px", borderRadius: 8 }}
        />
        <p className="small-note">Покажите карту сотруднику RPM</p>
      </div>
      <section className="referral-card">
        <Gift size={23} />
        <h2>
          Хорошие поездки
          <br />
          начинаются с друзей
        </h2>
        {!referral ? (
          <p>
            {referralError
              ? "Не удалось загрузить условия приглашения. Обновите страницу."
              : "Загружаем условия приглашения…"}
          </p>
        ) : referral.program?.activated_at ? (
          <>
            {referral.program.enabled ? (
              <>
                <p>После первой завершённой оплаченной аренды друга:</p>
                <p>
                  Вам — {referral.program.referrer.title}.{" "}
                  {referral.program.referrer.terms}
                </p>
                <p>
                  Другу — {referral.program.referred.title}.{" "}
                  {referral.program.referred.terms}
                </p>
              </>
            ) : (
              <p>
                Программа новых наград приостановлена. Ранее полученные награды
                сохраняются.
              </p>
            )}
          </>
        ) : (
          <p>
            Пригласите друга. После его первой аренды вам —{" "}
            {money(account.program.referrerReward, false)} Bonus, другу —{" "}
            {money(account.program.referredReward, false)}.
          </p>
        )}
        <div className="referral-code">
          <span>{referral?.code ?? account.user.referral_code}</span>
          <button
            onClick={invite}
            className="icon-button"
            aria-label="Скопировать приглашение"
            disabled={!referral}
          >
            {copied ? <Check size={18} /> : <Copy size={18} />}
          </button>
        </div>
        <button
          className="button button-wide"
          onClick={invite}
          disabled={!referral}
        >
          <Send size={18} />
          {copied ? "Приглашение скопировано" : "Пригласить друга"}
        </button>
        {referral?.items.length ? (
          <p className="small-note">
            Приглашений: {referral.items.length} · Наград:{" "}
            {referral.items.filter((r) => r.status === "rewarded").length}
          </p>
        ) : null}
      </section>
      {referral?.awards?.length ? (
        <section className="referral-card">
          <h2>Ваши награды</h2>
          {referral.awards.map((award) => (
            <div key={award.id}>
              <h3>{award.title}</h3>
              <p>{award.terms}</p>
              <p>{awardStatusLabels[award.status]}</p>
            </div>
          ))}
        </section>
      ) : null}
      <div className="profile-links">
        <a href={account.links.support} target="_blank" rel="noreferrer">
          <span>Написать RPM</span>
          <ArrowUpRight size={18} />
        </a>
        <Link href="/legal/rules">
          <span>Правила RPM Club</span>
          <ChevronRight size={18} />
        </Link>
        <Link href="/legal/privacy">
          <span>Политика конфиденциальности</span>
          <ChevronRight size={18} />
        </Link>
        <Link href="/legal/personal-data">
          <span>Обработка персональных данных</span>
          <ChevronRight size={18} />
        </Link>
        <label>
          <span>Предложения, маршруты и погода</span>
          <input
            type="checkbox"
            className="switch"
            checked={account.user.marketing_consent}
            onChange={(e) => void marketing(e.target.checked)}
          />
        </label>
      </div>
      <FormMessage error={error} />
      <button
        className="text-link logout"
        onClick={async () => {
          await command("auth/logout", {});
          router.replace("/onboarding");
        }}
      >
        <LogOut size={16} />
        Выйти
      </button>
    </>
  );
}
export function OfferDetail({ id }: { id: string }) {
  const { data: offer, error, loading } = useResource<Offer>("offers/" + id);
  if (loading) return <Loading />;
  if (error || !offer)
    return <Failure error={error ?? new Error("Предложение не найдено")} />;
  return (
    <main className="mini-shell offer-detail">
      <header className="mini-header">
        <Link href="/home" className="text-link">
          ← В клуб
        </Link>
        <Brand small />
      </header>
      <img
        className="offer-hero"
        src={offer.image_url || "/images/taycan.png"}
        alt={offer.car_name}
      />
      <div className="mini-content">
        <span className="offer-label">
          <b>RPM</b> DROP
        </span>
        <h1>{offer.title}</h1>
        <p className="screen-subtitle">{offer.subtitle}</p>
        <p className="offer-description">{offer.description}</p>
        {offer.new_price && (
          <div className="offer-prices">
            <strong>{money(offer.new_price)}</strong>
            {offer.old_price && <del>{money(offer.old_price)}</del>}
          </div>
        )}
        <div className="offer-meta">
          <TierBadge tier={offer.minimum_tier + "+"} />
          <span>До {date(offer.end_at)}</span>
        </div>
        <a
          className="button button-wide"
          href={offer.cta_url}
          target="_blank"
          rel="noreferrer"
          onClick={() => track("offer_clicked", offer.id)}
        >
          {offer.cta_text}
          <ArrowUpRight size={19} />
        </a>
        <p className="small-note">
          Условия и наличие автомобиля подтвердит менеджер RPM.
        </p>
      </div>
    </main>
  );
}
