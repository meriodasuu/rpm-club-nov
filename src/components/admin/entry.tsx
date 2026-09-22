"use client";
import { useState } from "react";
import { ShieldCheck, Send } from "lucide-react";
import {
  command,
  Dialog,
  Field,
  FormMessage,
  Spinner,
} from "@/components/shared";

export function AdminEntry() {
  const [open, setOpen] = useState(false);
  return (
    <div className="admin-entry">
      <button className="button button-wide" onClick={() => setOpen(true)}>
        <ShieldCheck size={22} />
        <span>Админ-панель</span>
        <Send size={20} />
      </button>
      {open && <AdminLinkRequest onClose={() => setOpen(false)} />}
    </div>
  );
}
function AdminLinkRequest({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [enrollment, setEnrollment] = useState<{
    qrCode: string;
    manualKey: string;
  }>();
  const [setup, setSetup] = useState(false);
  async function requestLink() {
    const result = await command<{ sent?: boolean; setup_required?: boolean }>(
      "auth/staff/bot-link",
      {},
    );
    if (result.sent) {
      setSent(true);
      setSetup(false);
      setEnrollment(undefined);
      return;
    }
    if (result.setup_required) {
      const initData = window.Telegram?.WebApp.initData;
      if (!initData)
        throw new Error(
          "Для настройки Google Authenticator откройте Mini App из Telegram.",
        );
      const factor = await command<{
        enrollment?: { qrCode: string; manualKey: string };
      }>("auth/staff/telegram", { initData });
      setEnrollment(factor.enrollment);
      setSetup(true);
    }
  }
  return (
    <Dialog title="Вход в админ-панель" onClose={onClose}>
      {sent ? (
        <div className="form-stack">
          <p role="status">
            Бот отправил ссылку в личный чат. Откройте её в браузере и введите
            код из Google Authenticator.
          </p>
          <p className="small-note">
            Ссылка действует 10 минут. Для работы на компьютере откройте
            сообщение в Telegram на компьютере.
          </p>
          <a
            className="button button-wide"
            href="https://t.me/rpmclub_bot"
            target="_blank"
            rel="noreferrer"
          >
            Открыть чат с ботом
          </a>
        </div>
      ) : (
        <form
          className="form-stack"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setBusy(true);
            setError("");
            try {
              if (setup)
                await command("auth/staff/telegram", {
                  initData: window.Telegram?.WebApp.initData ?? "",
                  otp: form.get("otp"),
                });
              await requestLink();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            {setup
              ? "Добавьте RPM Club в Google Authenticator и подтвердите настройку кодом."
              : "Получите ссылку в личном сообщении от бота. Для входа в браузере потребуется 6-значный код Google Authenticator."}
          </p>
          {enrollment && (
            <>
              <img
                src={enrollment.qrCode}
                width={220}
                height={220}
                alt="QR для Google Authenticator"
              />
              <Field label="Ключ для ручного ввода">
                <input
                  readOnly
                  value={enrollment.manualKey}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </Field>
              <p className="small-note">
                В Google Authenticator нажмите «+» и отсканируйте QR либо
                введите ключ. Тип кода — по времени.
              </p>
            </>
          )}
          {setup && (
            <Field label="Код Google Authenticator">
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
          <button className="button button-wide" disabled={busy}>
            {busy ? <Spinner /> : <Send size={18} />}
            {setup
              ? "Подтвердить и получить ссылку"
              : "Получить ссылку от бота"}
          </button>
          <p className="small-note">
            После настройки также можно отправить боту команду /admin.
          </p>
        </form>
      )}
    </Dialog>
  );
}
