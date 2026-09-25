"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Brand,
  Field,
  FormMessage,
  Spinner,
  command,
} from "@/components/shared";
import { ShieldCheck } from "lucide-react";
export function StaffLogin() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
        <h2>Вход в админ-панель</h2>
        <p>Введите почту и пароль сотрудника.</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            const form = new FormData(event.currentTarget);
            setBusy(true);
            setError("");
            try {
              await command("auth/staff/login", {
                email: form.get("email"),
                password: form.get("password"),
              });
              router.replace("/admin/dashboard");
            } catch (e) {
              setError(e instanceof Error ? e.message : "Не удалось войти");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Почта">
            <input
              name="email"
              type="email"
              autoComplete="username"
              maxLength={254}
              required
              disabled={busy}
            />
          </Field>
          <Field label="Пароль">
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              required
              disabled={busy}
            />
          </Field>
          <FormMessage error={error} />
          <button type="submit" className="button button-full" disabled={busy}>
            {busy ? <Spinner /> : "Войти"}
          </button>
        </form>
        <p className="small-note">
          Первый вход или забыли пароль? Отправьте <strong>/admin</strong>{" "}
          <a href="https://t.me/rpmclub_bot" target="_blank" rel="noreferrer">
            боту RPM Club
          </a>
          , чтобы задать почту и новый пароль. Доступ сотруднику выдаёт владелец
          клуба.
        </p>
      </div>
    </main>
  );
}
