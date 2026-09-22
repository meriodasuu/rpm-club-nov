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
