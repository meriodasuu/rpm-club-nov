"use client";
import { useState } from "react";
import {
  Brand,
  Field,
  FormMessage,
  Spinner,
  command,
} from "@/components/shared";
import { ShieldCheck } from "lucide-react";

export function TelegramStaffLogin({ initData }: { initData: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mfa, setMfa] = useState(false);
  const [enrollment, setEnrollment] = useState<{
    qrCode: string;
    manualKey: string;
  }>();
  return (
    <main className="login-page">
      <div className="login-visual">
        <Brand />
        <div>
          <span className="eyebrow">RPM CLUB / CONTROL</span>
          <h1>Управление клубом</h1>
          <p>Участники, поездки и привилегии.</p>
        </div>
      </div>
      <div className="login-form">
        <ShieldCheck size={28} className="red" />
        <h2>Вход через Telegram</h2>
        <p className="muted">
          {mfa
            ? "Введите код из приложения-аутентификатора."
            : "Подтвердите вход своим Telegram-аккаунтом."}
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setBusy(true);
            setError("");
            try {
              const result = await command<{
                mfa_required?: boolean;
                enrollment?: { qrCode: string; manualKey: string };
              }>("auth/staff/telegram", {
                initData,
                otp: mfa ? form.get("otp") : undefined,
              });
              if (result.mfa_required) {
                setMfa(true);
                setEnrollment(result.enrollment);
              } else window.location.replace("/admin/dashboard");
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {enrollment && (
            <div>
              <p className="small-note">
                Добавьте новую запись в приложение-аутентификатор: отсканируйте
                QR или скопируйте ключ и выберите код по времени.
              </p>
              <img
                src={enrollment.qrCode}
                width={220}
                height={220}
                alt="QR для настройки двухфакторной защиты"
              />
              <Field label="Ключ для ручного ввода">
                <input
                  value={enrollment.manualKey}
                  readOnly
                  onFocus={(event) => event.currentTarget.select()}
                />
              </Field>
              <p className="small-note">
                Сохраните запись в аутентификаторе: она понадобится при
                следующих входах.
              </p>
            </div>
          )}
          {mfa && (
            <Field label="Шестизначный код">
              <input
                name="otp"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                required
                autoFocus
              />
            </Field>
          )}
          <FormMessage error={error} />
          <button className="button button-full" disabled={busy}>
            {busy ? <Spinner /> : <ShieldCheck size={18} />}
            {mfa ? "Войти" : "Войти через Telegram"}
          </button>
        </form>
      </div>
    </main>
  );
}
