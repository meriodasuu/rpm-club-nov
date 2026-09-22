"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Smartphone, LayoutDashboard } from "lucide-react";
import { Brand, command, FormMessage, Spinner } from "./shared";
export function Preview() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const router = useRouter();
  async function login(mode: string) {
    setBusy(true);
    setError("");
    try {
      const result = await command<{ redirect: string }>("auth/local", {
        mode,
      });
      router.push(result.redirect);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <main className="preview-page">
      <header>
        <Brand />
        <span className="environment-label">Локальная среда</span>
      </header>
      <div className="preview-content">
        <div className="preview-copy">
          <span className="red-rule" />
          <h1>
            Каждая поездка.
            <br />
            <span>Новый уровень.</span>
          </h1>
          <p>
            RPM Club объединяет аренды, Bonus и привилегии в одном пространстве.
          </p>
          <div className="preview-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => login("client")}
            >
              <Smartphone size={20} />
              Открыть клуб
              <ArrowRight size={20} />
            </button>
            <button
              className="button button-outline"
              disabled={busy}
              onClick={() => login("admin")}
            >
              <LayoutDashboard size={20} />
              Панель управления
            </button>
          </div>
          <FormMessage error={error} />
          {busy && <Spinner />}
          <p className="preview-note">
            Тестовые участники и операции сохраняются в локальной базе. Этот
            экран и вход без Telegram отключены в production.
          </p>
        </div>
        <div className="preview-visual">
          <img src="/images/taycan.png" alt="Porsche Taycan в тёмной студии" />
          <div className="preview-word">RPM</div>
        </div>
      </div>
      <footer>
        <span>RPM RENT / RPM CLUB</span>
        <div>
          <button onClick={() => login("new")} disabled={busy}>
            Новый участник
          </button>
          <button onClick={() => login("manager")} disabled={busy}>
            Менеджер
          </button>
          <button onClick={() => login("viewer")} disabled={busy}>
            Просмотр
          </button>
        </div>
      </footer>
    </main>
  );
}
