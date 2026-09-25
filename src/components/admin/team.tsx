"use client";
import { useState } from "react";
import { Search, UserRoundPlus } from "lucide-react";
import {
  api,
  command,
  useResource,
  Field,
  FormMessage,
  Failure,
  Spinner,
} from "@/components/shared";
import { DataTable, PageHeading } from "./tables";
type TeamMember = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  telegram_user_id: string | null;
  telegram_username: string | null;
  role: string;
  active: boolean;
  can_manage_staff: boolean;
};
type Candidate = {
  id: string;
  name: string;
  phone: string;
  telegram_username: string | null;
  staff_active: boolean | null;
  staff_role: string | null;
  can_manage_staff: boolean | null;
};
export function TeamPage() {
  const { data, error, refresh } = useResource<{
    items: TeamMember[];
    can_manage_staff: boolean;
  }>("admin/team");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [success, setSuccess] = useState("");
  async function update(
    userId: string,
    active: boolean,
    expectedUsername?: string,
  ) {
    setBusy(true);
    setMessage("");
    setSuccess("");
    try {
      await command("admin/team/telegram", {
        userId,
        active,
        expectedUsername,
      });
      setSuccess(
        active
          ? "Администратор назначен. Теперь он может отправить боту /admin и задать почту и пароль для входа."
          : "Доступ отключён. Открытые сессии администратора завершены.",
      );
      setCandidates(null);
      await refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Сотрудники"
        subtitle="Администраторы RPM Club и их доступ"
      />
      {error && <Failure error={error} />}
      {data?.can_manage_staff && (
        <section className="panel" id="add-admin">
          <div className="panel-header">
            <h2>Добавить администратора</h2>
          </div>
          <div className="panel-body form-stack">
            <p className="small-note">
              Пользователь должен зарегистрироваться в @rpmclub_bot. Введите его
              Telegram-ник, проверьте найденный аккаунт и назначьте доступ.
            </p>
            <form
              className="form-stack"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                setBusy(true);
                setMessage("");
                setSuccess("");
                setCandidates(null);
                try {
                  const found = await api<{ items: Candidate[] }>(
                    "admin/team/candidates?username=" +
                      encodeURIComponent(String(form.get("username"))),
                  );
                  setCandidates(found.items);
                } catch (error) {
                  setMessage((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label="Telegram-ник">
                <input
                  name="username"
                  disabled={busy}
                  type="text"
                  required
                  maxLength={33}
                  placeholder="@wthtwn"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={() => setCandidates(null)}
                />
              </Field>
              <div>
                <button className="button button-outline" disabled={busy}>
                  {busy ? <Spinner /> : <Search size={18} />}Найти пользователя
                </button>
              </div>
            </form>
            {candidates?.length === 0 && (
              <p>
                Пользователь не найден. Проверьте Telegram-ник и попросите его
                открыть Club через бота и завершить регистрацию.
              </p>
            )}
            {candidates?.map((candidate) => (
              <div key={candidate.id} className="staff-candidate">
                <div>
                  <strong>{candidate.name}</strong>
                  <p>
                    {candidate.telegram_username
                      ? `@${candidate.telegram_username}`
                      : ""}
                  </p>
                </div>
                {candidate.can_manage_staff ? (
                  <span>Владелец</span>
                ) : candidate.staff_active &&
                  candidate.staff_role === "admin" ? (
                  <span>Уже администратор</span>
                ) : (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void update(
                        candidate.id,
                        true,
                        candidate.telegram_username ?? undefined,
                      )
                    }
                  >
                    <UserRoundPlus size={18} />
                    Назначить администратором
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <FormMessage error={message} success={success} />
      {data && !data.can_manage_staff && (
        <p className="small-note">
          Назначать и отключать администраторов может только владелец клуба.
        </p>
      )}
      <section className="panel">
        {data && (
          <DataTable
            headings={[
              "Имя",
              "Учётная запись",
              "Доступ",
              "Статус",
              ...(data.can_manage_staff ? ["Управление"] : []),
            ]}
            rows={data.items}
            render={(row) => (
              <>
                <td>{String(row.name)}</td>
                <td>
                  {String(
                    row.telegram_username
                      ? `@${row.telegram_username}`
                      : (row.email ?? "Telegram"),
                  )}
                </td>
                <td>
                  {row.can_manage_staff
                    ? "Владелец"
                    : row.role === "admin"
                      ? "Администратор"
                      : row.role === "manager"
                        ? "Менеджер"
                        : "Просмотр"}
                </td>
                <td>{row.active ? "Активен" : "Отключён"}</td>
                {data.can_manage_staff && (
                  <td>
                    {row.can_manage_staff ? (
                      "Доступ владельца"
                    ) : row.telegram_user_id ? (
                      <button
                        className="button button-outline"
                        disabled={busy}
                        onClick={() =>
                          void update(String(row.telegram_user_id), !row.active)
                        }
                      >
                        {row.active
                          ? "Отключить доступ"
                          : "Назначить администратором"}
                      </button>
                    ) : (
                      "Учётная запись по почте"
                    )}
                  </td>
                )}
              </>
            )}
          />
        )}
      </section>
    </>
  );
}
