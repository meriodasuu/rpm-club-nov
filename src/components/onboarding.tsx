"use client";
import Link from "next/link";
import { NotificationActivity } from "./miniapp/notifications";
import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Phone } from "lucide-react";
import {
  api,
  command,
  ApiError,
  Brand,
  Spinner,
  Field,
  FormMessage,
} from "./shared";
type OnboardingState = {
  active: boolean;
  contact_verified: boolean;
  phone: string | null;
  documents: { id: string; type: string; version: string; title: string }[];
};
function enterClub() {
  const next = sessionStorage.getItem("rpm:return-to");
  sessionStorage.removeItem("rpm:return-to");
  const allowed = [
    "/home",
    "/club",
    "/rent",
    "/profile",
    "/history",
    "/routes",
    "/wiki",
    "/conditions",
    "/contacts",
  ];
  let url: URL | null = null;
  try {
    url = next ? new URL(next, location.origin) : null;
  } catch {
    /* Invalid saved navigation falls back to the home screen. */
  }
  window.location.replace(
    url && url.origin === location.origin && allowed.includes(url.pathname)
      ? url.pathname + url.search
      : "/home",
  );
}
export function Onboarding({ botUrl }: { botUrl?: string }) {
  const [data, setData] = useState<OnboardingState | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [referral, setReferral] = useState("");
  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        const app = window.Telegram?.WebApp;
        app?.ready();
        app?.expand();
        if (app?.initData) {
          const result = await command<{ onboarding_required: boolean }>(
            "auth/telegram",
            { initData: app.initData },
          );
          const params = new URLSearchParams(app.initData);
          const start = params.get("start_param");
          if (start?.startsWith("ref_")) setReferral(start.slice(4));
          if (!result.onboarding_required) {
            enterClub();
            return;
          }
        }
        const state = await api<OnboardingState>("me/onboarding");
        if (state.active) {
          enterClub();
          return;
        }
        if (!cancelled) setData(state);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void start();
    return () => {
      cancelled = true;
    };
  }, []);
  async function contact() {
    setBusy(true);
    setError("");
    try {
      await command("me/contact-request", {});
      const app = window.Telegram?.WebApp;
      if (!app) throw new Error("Подтвердите телефон внутри Telegram");
      await new Promise<void>((resolve, reject) =>
        app.requestContact((accepted) =>
          accepted
            ? resolve()
            : reject(new Error("Номер не передан. Повторите подтверждение.")),
        ),
      );
      let state: OnboardingState | null = null;
      for (let i = 0; i < 8; i++) {
        state = await api<OnboardingState>("me/onboarding");
        if (state.contact_verified) break;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      if (!state?.contact_verified)
        throw new Error(
          "Подтверждение ещё не получено. Повторите через несколько секунд.",
        );
      setData(state);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="onboarding-page">
      {data && <NotificationActivity />}
      <header>
        <Brand />
        <span className="eyebrow">ВАШ ДОСТУП ВНУТРЬ RPM</span>
      </header>
      <div className="onboarding-art">
        <img src="/images/taycan.png" alt="Porsche Taycan в RPM" />
        <span className="art-line" />
      </div>
      <div className="onboarding-body">
        <span className="eyebrow red">RPM CLUB</span>
        <h1>
          Больше, чем
          <br />
          аренда.
        </h1>
        <p className="onboarding-intro">
          Ваши поездки открывают новые привилегии. Карта клуба, скидки на аренду
          и особые предложения — здесь.
        </p>
        {loading ? (
          <Spinner />
        ) : data ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const f = new FormData(e.currentTarget);
                await command("me/activate", {
                  documentIds: data.documents.map((d) => d.id),
                  referralCode: referral || undefined,
                  marketingConsent: f.get("marketing") === "on",
                });
                enterClub();
              } catch (e) {
                setError((e as Error).message);
                if (
                  e instanceof ApiError &&
                  ["CONTACT_REQUIRED", "RULES_CHANGED"].includes(e.code)
                ) {
                  if (e.code === "CONTACT_REQUIRED")
                    setData((current) =>
                      current
                        ? { ...current, contact_verified: false, phone: null }
                        : current,
                    );
                  try {
                    setData(await api<OnboardingState>("me/onboarding"));
                  } catch {
                    setError(
                      `${e.message} Не удалось обновить данные. Повторите попытку.`,
                    );
                  }
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            <button
              className="button button-outline button-full"
              type="button"
              onClick={() => void contact()}
              disabled={busy || data.contact_verified}
            >
              {data.contact_verified ? (
                <Check size={18} />
              ) : (
                <Phone size={18} />
              )}{" "}
              {data.contact_verified ? data.phone : "Подтвердить телефон"}
            </button>
            <Field label="Код приглашения · необязательно">
              <input
                value={referral}
                maxLength={30}
                onChange={(e) => setReferral(e.target.value.trim())}
                placeholder="RPM…"
              />
            </Field>
            {data.documents.map((d) => (
              <label key={d.id} className="checkbox-field">
                <input type="checkbox" required />
                <span>
                  Принимаю{" "}
                  <Link
                    href={
                      "/legal/" +
                      d.type +
                      "?version=" +
                      encodeURIComponent(d.version)
                    }
                    target="_blank"
                  >
                    {d.title.toLowerCase()}
                  </Link>
                </span>
              </label>
            ))}
            <label className="checkbox-field">
              <input type="checkbox" name="marketing" />
              <span>Хочу получать RPM Drop и предложения клуба в Telegram</span>
            </label>
            <FormMessage error={error} />
            <button
              className="button button-full"
              disabled={
                busy || !data.contact_verified || data.documents.length !== 3
              }
            >
              {busy ? <Spinner /> : <ArrowUpRight size={18} />}Вступить в RPM
              Club
            </button>
          </form>
        ) : (
          <>
            <FormMessage error={error} />
            <p className="small-note">
              Откройте RPM Club через кнопку приложения в Telegram-боте RPM.
            </p>
            <a
              className="button button-outline"
              href={botUrl ?? "https://rpmrent.ru"}
            >
              {botUrl ? "Открыть Telegram-бота" : "Перейти в RPM"}
              <ArrowUpRight size={17} />
            </a>
          </>
        )}
      </div>
    </main>
  );
}
