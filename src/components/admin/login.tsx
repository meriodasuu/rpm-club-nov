"use client";
import { Brand } from "@/components/shared";
import { ShieldCheck, Send } from "lucide-react";
export function StaffLogin() {
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
        <p>
          Получите личную ссылку у бота RPM Club командой{" "}
          <strong>/admin</strong>. Откройте её в браузере и введите 6-значный
          код Google Authenticator.
        </p>
        <a
          className="button button-full"
          href="https://t.me/rpmclub_bot"
          target="_blank"
          rel="noreferrer"
        >
          <Send size={18} />
          Открыть бота RPM Club
        </a>
        <p className="small-note">
          Доступ выдаёт владелец клуба. При первом открытии ссылки настройте
          Google Authenticator прямо на странице входа.
        </p>
      </div>
    </main>
  );
}
