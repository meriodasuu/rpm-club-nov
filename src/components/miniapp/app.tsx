"use client";
import {
  awardStatusLabels,
  type ReferralProgram,
  type ReferralAward,
} from "@/lib/referrals/contracts";
import { useEffect, useRef, useState } from "react";
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
import { ContactsScreen } from "./contacts";
import { CardCarousel } from "./cards";
import { NotificationActivity, NotificationPreferences } from "./notifications";
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

// Public support must remain usable when sign-in or the account API is unavailable.
export function ContactsApp() {
  useEffect(() => {
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
  }, []);
  return (
    <div className="mini-backdrop">
      <main className="mini-shell">
        <header className="mini-header">
          <Link href="/home" aria-label="RPM Club — Главная">
            <Brand />
          </Link>
          <Link href="/profile" className="avatar" aria-label="Профиль">
            <UserRound size={20} />
          </Link>
        </header>
        <div className="mini-content">
          <Link className="mini-back-link" href="/home">
            ← На главную
          </Link>
          <ContactsScreen />
        </div>
        <nav className="bottom-nav" aria-label="Основная навигация">
          {navigation.map((n) => (
            <Link key={n.href} href={n.href}>
              <n.icon size={23} strokeWidth={1.65} />
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>
      </main>
    </div>
  );
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
  const scrolledTo = useRef("");
  useEffect(() => {
    if (!account) return;
    const destination = pathname + location.hash;
    if (scrolledTo.current === destination) return;
    scrolledTo.current = destination;
    if (["#my-requests", "#invite-friend"].includes(location.hash)) {
      document
        .getElementById(location.hash.slice(1))
        ?.scrollIntoView({ block: "start" });
    }
  }, [account, pathname]);
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tg?.ready();
    tg?.expand();
    if (tg?.initData) tg.BackButton.hide();
  }, []);
  useEffect(() => {
    if (
      error &&
      "code" in error &&
      ["AUTH_REQUIRED", "SESSION_EXPIRED", "ONBOARDING_REQUIRED"].includes(
        String(error.code),
      )
    ) {
      sessionStorage.setItem(
        "rpm:return-to",
        location.pathname + location.search,
      );
      location.replace("/onboarding");
    }
  }, [error]);
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
      <NotificationActivity />
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
  const currentTier = account.program.tiers.find(
    (t) => t.code === account.tier,
  )!;
  return (
    <>
      <p className="home-greeting">
        {account.user.name.split(" ")[0]}, рады видеть вас
      </p>
      <h1 className="home-title">Куда отправимся?</h1>
      <section className="home-rental" aria-label="Ваша следующая поездка">
        <CarFront size={36} strokeWidth={1.4} aria-hidden="true" />
        <h2>Автомобиль для ваших планов</h2>
        <p>
          Выберите автомобиль и даты. Менеджер подтвердит заявку, оплата — на
          месте.
        </p>
        <div className="home-actions">
          <Link className="button button-wide" href="/rent">
            Выбрать автомобиль <ArrowRight size={22} />
          </Link>
          <Link className="button button-outline" href="/rent#my-requests">
            Мои заявки
          </Link>
        </div>
      </section>
      <Link
        className="home-membership"
        href="/club"
        aria-label="Мой статус и привилегии в Club"
      >
        <div>
          <span>Ваш уровень</span>
          <strong>{tierName(currentTier)}</strong>
          <small>Карта и привилегии в Club</small>
        </div>
        <div className="home-membership-rate">
          <strong>{account.discount_rate_bps / 100}%</strong>
          <span>скидка</span>
        </div>
        <ChevronRight size={20} aria-hidden="true" />
      </Link>
      <ClubLinks />
      {offers?.items[0] && (
        <section className="home-offer" aria-label="Предложение для вас">
          <h2>Предложение для вас</h2>
          <OfferCard offer={offers.items[0]} />
        </section>
      )}
      <div className="mini-note">Ваша следующая поездка начинается здесь.</div>
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
      <p className="screen-subtitle">Ваша карта, уровни и привилегии</p>
      <CardCarousel account={account} />
      <div className="club-membership-actions">
        <Link className="button button-outline" href="/conditions">
          Условия программы
        </Link>
        <Link className="button button-outline" href="/profile#invite-friend">
          Пригласить друга
        </Link>
      </div>
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
  const [tab, setTab] = useState<"rentals" | "requests">("rentals");
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
          aria-selected={tab === "requests"}
          onClick={() => setTab("requests")}
        >
          Заявки
        </button>
      </div>
      {tab === "requests" ? <RentalRequests /> : <RentalHistory />}
    </>
  );
}
function RentalHistory() {
  const [cursor, setCursor] = useState<string | null>(null),
    [previous, setPrevious] = useState<Record<string, unknown>[]>([]);
  const { data, error, loading, refresh } = useResource<{
    items: Record<string, unknown>[];
    nextCursor: string | null;
  }>(
    `me/rentals?limit=20${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
  );
  if (error) return <Failure error={error} retry={refresh} />;
  if (loading) return <Loading />;
  const items = [...previous, ...(data?.items ?? [])];
  if (!items.length)
    return (
      <Empty title="Аренд пока нет">
        После завершённой аренды здесь появятся ваши поездки.
      </Empty>
    );
  return (
    <div className="history-list">
      {items.map((row) => (
        <article className="history-row" key={String(row.id)}>
          <div className="car-thumb">
            <CarFront size={22} aria-hidden="true" />
          </div>
          <div className="history-info">
            <strong>{String(row.car_name)}</strong>
            <span>
              {date(String(row.start_date))} — {date(String(row.end_date))}
            </span>
          </div>
          <div className="history-amount">
            <strong>
              {money(String(row.current_amount_kopecks ?? row.amount_kopecks))}
            </strong>
            <span>{labels[String(row.status)] ?? String(row.status)}</span>
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
          <dt>Скидка по карте</dt>
          <dd>{account.discount_rate_bps / 100}%</dd>
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
      <section className="referral-card" id="invite-friend">
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
            Поделитесь приглашением с другом. Условия наград появятся здесь,
            когда команда RPM запустит программу приглашений.
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
      <NotificationPreferences />
      <div className="profile-links">
        <Link href="/contacts">
          <span>Связаться с RPM</span>
          <ChevronRight size={18} />
        </Link>
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
