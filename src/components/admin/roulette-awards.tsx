"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  command,
  Dialog,
  Failure,
  Loading,
  useResource,
} from "@/components/shared";

type AwardRecord = {
  id: string;
  user_id: string;
  user_name: string;
  public_member_id: string;
  claim_code: string;
  effective_status: string;
  issued_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
  redeemed_by_name: string | null;
  reserved_request_id: string | null;
  prize_snapshot: { title: string; terms: string };
};
type Result = { items: AwardRecord[]; page: number; hasMore: boolean };
const statusLabels: Record<string, string> = {
  active: "Активные",
  archive: "Архив",
  available: "Доступен",
  reserved: "В заявке на аренду",
  redeemed: "Использован",
  expired: "Истёк",
};
function moment(value: string) {
  return (
    new Date(value).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) +
    " МСК"
  );
}

export function RouletteAwardHistory({
  userId,
  canRedeem,
}: {
  userId?: string;
  canRedeem: boolean;
}) {
  const [searchDraft, setSearchDraft] = useState("");
  const [statusDraft, setStatusDraft] = useState("");
  const [fromDraft, setFromDraft] = useState("");
  const [toDraft, setToDraft] = useState("");
  const [filters, setFilters] = useState({
    search: "",
    status: "",
    from: "",
    to: "",
  });
  const [page, setPage] = useState(1);
  const [confirming, setConfirming] = useState<AwardRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const params = new URLSearchParams({ page: String(page) });
  if (userId) params.set("userId", userId);
  if (filters.search) params.set("q", filters.search);
  if (filters.status) params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  const awards = useResource<Result>(`admin/roulette/awards?${params}`);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters({
      search: searchDraft.trim(),
      status: statusDraft,
      from: fromDraft,
      to: toDraft,
    });
    setPage(1);
  }

  return (
    <>
      <form className="roulette-awards-filters" onSubmit={applyFilters}>
        {!userId && (
          <input
            aria-label="Поиск по участнику или коду"
            placeholder="Имя, ID или код приза"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            maxLength={80}
          />
        )}
        <select
          aria-label="Статус приза"
          value={statusDraft}
          onChange={(event) => setStatusDraft(event.target.value)}
        >
          <option value="">Все призы</option>
          <option value="active">Активные</option>
          <option value="archive">Архив</option>
          {Object.entries(statusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <label>
          От{" "}
          <input
            type="date"
            value={fromDraft}
            onChange={(event) => setFromDraft(event.target.value)}
          />
        </label>
        <label>
          До{" "}
          <input
            type="date"
            value={toDraft}
            onChange={(event) => setToDraft(event.target.value)}
          />
        </label>
        <button type="submit" className="button button-outline">
          Найти
        </button>
      </form>
      {awards.error ? (
        <Failure error={awards.error} retry={awards.refresh} />
      ) : awards.loading ? (
        <Loading />
      ) : !awards.data?.items.length ? (
        <p className="small-note">
          {userId && !filters.status && !filters.from && !filters.to
            ? "У участника пока нет призов."
            : "Призов по выбранным условиям нет."}
        </p>
      ) : (
        <div className="data-table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Выигрыш</th>
                {!userId && <th>Участник</th>}
                <th>Приз</th>
                <th>Код</th>
                <th>Статус</th>
                <th>Действует до</th>
                <th>Активация</th>
              </tr>
            </thead>
            <tbody>
              {awards.data.items.map((award) => (
                <tr key={award.id}>
                  <td>{moment(award.issued_at)}</td>
                  {!userId && (
                    <td>
                      <Link
                        href={`/admin/customers/${award.user_id}#customer-prizes`}
                      >
                        {award.user_name}
                      </Link>
                      <small className="roulette-history-note">
                        {award.public_member_id}
                      </small>
                    </td>
                  )}
                  <td>
                    <strong>{award.prize_snapshot.title}</strong>
                  </td>
                  <td>
                    <code>{award.claim_code}</code>
                  </td>
                  <td>
                    {statusLabels[award.effective_status] ??
                      award.effective_status}
                  </td>
                  <td>{moment(award.expires_at)}</td>
                  <td>
                    {award.redeemed_at ? (
                      <>
                        {moment(award.redeemed_at)}
                        <small className="roulette-history-note">
                          {award.redeemed_by
                            ? `Сотрудник: ${award.redeemed_by_name || award.redeemed_by}`
                            : "Ранее — через заявку"}
                        </small>
                      </>
                    ) : award.effective_status === "available" && canRedeem ? (
                      <button
                        type="button"
                        className="button button-small"
                        onClick={() => {
                          setConfirming(award);
                          setActionError("");
                        }}
                      >
                        Подтвердить
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="roulette-history-pages">
        <button
          type="button"
          className="button button-outline"
          disabled={page === 1}
          onClick={() => setPage(page - 1)}
        >
          ← Назад
        </button>
        <span>Страница {page}</span>
        <button
          type="button"
          className="button button-outline"
          disabled={!awards.data?.hasMore}
          onClick={() => setPage(page + 1)}
        >
          Далее →
        </button>
      </div>
      {confirming && (
        <Dialog
          title="Подтвердить активацию"
          onClose={() => setConfirming(null)}
          busy={busy}
        >
          <div className="form-stack">
            <p>
              Участник: <strong>{confirming.user_name}</strong> ·{" "}
              {confirming.public_member_id}
            </p>
            <p>
              Приз: <strong>{confirming.prize_snapshot.title}</strong>
            </p>
            <p>
              Код: <code>{confirming.claim_code}</code>
            </p>
            <p>
              Сверьте код и участника. Подтверждайте только после обращения в
              офис RPM или к менеджеру.
            </p>
            {actionError && (
              <p role="alert" className="form-error">
                {actionError}
              </p>
            )}
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setActionError("");
                try {
                  await command(
                    `admin/roulette/awards/${confirming.id}/redeem`,
                    {},
                    "POST",
                  );
                  setConfirming(null);
                  await awards.refresh();
                } catch (cause) {
                  setActionError((cause as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Активировать приз
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
