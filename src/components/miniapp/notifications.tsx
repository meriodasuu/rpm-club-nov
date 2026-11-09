"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  command,
  useResource,
  Field,
  FormMessage,
  Failure,
} from "@/components/shared";
export function NotificationActivity() {
  const path = usePathname();
  useEffect(() => {
    const notification = new URLSearchParams(location.search).get(
      "notification",
    );
    void command("me/notification-activity", {
      path,
      ...(notification ? { notification } : {}),
    }).catch(() => undefined);
  }, [path]);
  return null;
}
type Preferences = {
  enabled: boolean;
  birthday: string | null;
  birthday_consent_at: string | null;
};
type MarketingPreferences = { offersEnabled: boolean; routesEnabled: boolean };
export function MarketingPreferences() {
  const topics = useResource<MarketingPreferences>("me/marketing-preferences");
  const general = useResource<Preferences>("me/notification-preferences");
  const refreshGeneral = general.refresh;
  useEffect(() => {
    const refresh = () => { void refreshGeneral(); };
    window.addEventListener("rpm:notification-preferences-updated", refresh);
    return () => window.removeEventListener("rpm:notification-preferences-updated", refresh);
  }, [refreshGeneral]);
  const [saving, setSaving] = useState<"offers" | "routes" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function change(topic: "offers" | "routes", enabled: boolean) {
    setSaving(topic); setError(""); setMessage("");
    try {
      await command("me/marketing-preferences", { topic, enabled }, "PATCH");
      await topics.refresh();
      setMessage("Настройка сохранена");
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(null); }
  }
  return <section className="panel" aria-label="Что получать в Telegram">
    <div className="panel-header"><h2>Что получать в Telegram</h2></div>
    <div className="panel-body form-stack">
      {topics.error ? <Failure error={topics.error} retry={topics.refresh} /> : topics.data ? <>
        <label className="checkbox-field"><input type="checkbox" checked={topics.data.offersEnabled} disabled={!!saving} onChange={(e) => void change("offers", e.target.checked)} />Специальные предложения RPM Club</label>
        <label className="checkbox-field"><input type="checkbox" checked={topics.data.routesEnabled} disabled={!!saving} onChange={(e) => void change("routes", e.target.checked)} />Новые маршруты RPM Club</label>
      </> : <p>Загружаем настройки…</p>}
      {general.data?.enabled === false && <p>Уведомления клуба выключены — сообщения не придут.</p>}
      <p role="status">{saving ? "Сохраняем…" : message}</p><FormMessage error={error} />
    </div>
  </section>;
}
export function NotificationPreferences() {
  const r = useResource<Preferences>("me/notification-preferences");
  return r.error ? (
    <Failure error={r.error} retry={r.refresh} />
  ) : r.data ? (
    <PreferenceForm
      key={JSON.stringify(r.data)}
      value={r.data}
      refresh={r.refresh}
    />
  ) : null;
}
function PreferenceForm({
  value,
  refresh,
}: {
  value: Preferences;
  refresh: () => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(value.enabled),
    [birthday, setBirthday] = useState(value.birthday ?? ""),
    [consent, setConsent] = useState(!!value.birthday_consent_at),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  return (
    <details className="panel">
      <summary className="panel-header">Уведомления и день рождения</summary>
      <form
        className="panel-body form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          setError("");
          try {
            await command("me/notification-preferences", {
              enabled,
              birthday: consent && birthday ? birthday : null,
              birthdayConsent: consent,
            });
            setMessage("Сохранено");
            await refresh();
            window.dispatchEvent(new Event("rpm:notification-preferences-updated"));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Получать напоминания о незавершённых действиях и событиях клуба
        </label>
        <Field label="Дата рождения · необязательно">
          <input
            type="date"
            value={birthday}
            disabled={busy}
            onChange={(e) => setBirthday(e.target.value)}
          />
        </Field>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={consent}
            disabled={busy}
            onChange={(e) => setConsent(e.target.checked)}
          />
          Согласен на хранение даты рождения для поздравлений клуба. Можно
          отозвать согласие здесь: дата будет удалена из профиля.
        </label>
        <p className="small-note">
          Рекламные сообщения зависят также от отдельного согласия на
          предложения. Обязательные сообщения по операциям сохраняются.
        </p>
        <FormMessage success={message} error={error} />
        <button className="button" disabled={busy}>
          Сохранить
        </button>
      </form>
    </details>
  );
}
