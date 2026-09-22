"use client";
import { useState } from "react";
import {
  command,
  useResource,
  Loading,
  Failure,
  Field,
  FormMessage,
  Dialog,
  Spinner,
} from "@/components/shared";
import { PageHeading, DataTable, Pagination, type Row } from "./tables";
import type { StaffView } from "./shell";
import {
  awardStatusLabels,
  type ReferralAward,
  type ReferralProgram,
} from "@/lib/referrals/contracts";
import { date, labels, money } from "@/lib/ui";
import { useUnsavedChanges } from "./unsaved";

export function ReferralsPage({ staff }: { staff: StaffView }) {
  const config = useResource<{ program: ReferralProgram | null }>(
    "admin/referral-program",
  );
  const [page, setPage] = useState(0),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("");
  const rows = useResource<{ items: Row[] }>(
    `admin/referrals?page=${page}&q=${encodeURIComponent(search)}&status=${status}`,
  );
  const [selected, setSelected] = useState<{
    award: ReferralAward;
    name: string;
    car: string;
  } | null>(null);
  return (
    <>
      <PageHeading
        title="Приглашения друзей"
        subtitle="Условия программы и фактическая выдача наград"
      />
      {config.error ? (
        <Failure error={config.error} retry={config.refresh} />
      ) : !config.data ? (
        <Loading />
      ) : (
        <>
          {staff.role === "admin" ? (
            <ReferralSettings
              key={config.data.program?.id ?? "new"}
              program={config.data.program}
              onDone={config.refresh}
            />
          ) : (
            <section className="panel panel-body">
              <h2>Условия программы</h2>
              <p>
                {config.data.program?.enabled
                  ? "Программа включена"
                  : "Ручная программа не включена"}
              </p>
              {config.data.program && (
                <>
                  <p>
                    Пригласившему: {config.data.program.referrer.title} —{" "}
                    {config.data.program.referrer.terms}
                  </p>
                  <p>
                    Другу: {config.data.program.referred.title} —{" "}
                    {config.data.program.referred.terms}
                  </p>
                </>
              )}
            </section>
          )}
        </>
      )}
      <section className="panel">
        <div className="panel-body form-grid">
          <Field label="Поиск участника">
            <input
              type="search"
              value={search}
              placeholder="Имя, телефон или ID"
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </Field>
          <Field label="Выдача награды">
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(0);
              }}
            >
              <option value="">Все</option>
              {Object.entries(awardStatusLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {rows.error ? (
          <Failure error={rows.error} retry={rows.refresh} />
        ) : !rows.data ? (
          <Loading />
        ) : (
          <>
            <DataTable
              headings={[
                "Пригласил",
                "Друг",
                "Статус",
                "Награды",
                "Аренда",
                "Дата",
              ]}
              rows={rows.data.items}
              render={(r) => (
                <>
                  <td>{String(r.referrer_name)}</td>
                  <td>{String(r.referred_name)}</td>
                  <td>
                    {r.manual_version_id && r.status === "rewarded"
                      ? "Награды выданы"
                      : (labels[String(r.status)] ?? String(r.status))}
                    {r.reason === "blocked_hold" && (
                      <small> · Участник заблокирован</small>
                    )}
                  </td>
                  <td>
                    {(r.awards as ReferralAward[]).length
                      ? (r.awards as ReferralAward[]).map((award) => (
                          <div key={award.id} className="referral-award">
                            <strong>
                              {award.side === "referrer"
                                ? "Пригласившему"
                                : "Другу"}
                              : {award.title}
                            </strong>
                            <p>{award.terms}</p>
                            <small>
                              {awardStatusLabels[award.status]}
                              {award.issued_at && ` · ${date(award.issued_at)}`}
                            </small>
                            {staff.role !== "viewer" &&
                              award.status === "pending" && (
                                <button
                                  className="button button-outline"
                                  onClick={() =>
                                    setSelected({
                                      award,
                                      name: String(
                                        award.side === "referrer"
                                          ? r.referrer_name
                                          : r.referred_name,
                                      ),
                                      car: String(r.car_name ?? "Аренда"),
                                    })
                                  }
                                >
                                  Отметить выдачу
                                </button>
                              )}
                          </div>
                        ))
                      : r.manual_version_id
                        ? "Награды не созданы"
                        : r.referrer_reward !== null
                          ? `Прежняя программа: ${money(String(r.referrer_reward), false)} / ${money(String(r.referred_reward), false)} Bonus`
                          : "После первой завершённой оплаченной аренды"}
                  </td>
                  <td>
                    {String(r.car_name ?? "—")}
                    <small className="muted">
                      {String(r.external_rental_id ?? "")}
                    </small>
                  </td>
                  <td>{date(String(r.created_at))}</td>
                </>
              )}
            />
            <Pagination
              page={page}
              onChange={setPage}
              hasNext={rows.data.items.length === 50}
            />
          </>
        )}
      </section>
      {selected && (
        <IssueAward
          selected={selected}
          onClose={() => setSelected(null)}
          onDone={() => {
            setSelected(null);
            void rows.refresh();
          }}
        />
      )}
    </>
  );
}
function ReferralSettings({
  program,
  onDone,
}: {
  program: ReferralProgram | null;
  onDone: () => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(program?.enabled ?? false),
    [preview, setPreview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [rewards, setRewards] = useState({
    referrer: program?.referrer ?? { title: "", terms: "" },
    referred: program?.referred ?? { title: "", terms: "" },
  });
  const guard = useUnsavedChanges();
  return (
    <form
      className="panel"
      onChange={() => {
        guard.markDirty();
        setPreview(false);
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!preview) {
          setPreview(true);
          return;
        }
        setBusy(true);
        setError("");
        try {
          const f = new FormData(e.currentTarget);
          await command("admin/referral-program", {
            enabled,
            ...rewards,
            expectedVersion: program?.version ?? 0,
            reason: String(f.get("reason")),
          });
          guard.markSaved();
          await onDone();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="panel-header">
        <h2>
          Условия программы{program ? ` · версия ${program.version}` : ""}
        </h2>
      </div>
      <fieldset disabled={busy} className="panel-body form-stack">
        <p className="small-note">
          После первой завершённой оплаченной аренды создаются две награды.
          Менеджер вручную отмечает выдачу. Новые условия не меняют уже
          возникшие награды и старые аренды.
        </p>
        {!program?.activated_at && (
          <p className="small-note">
            До первого включения действует прежняя программа Bonus. Ручные
            награды применятся только к арендам, созданным после включения.
          </p>
        )}
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Включить ручные награды за приглашения
        </label>
        {(["referrer", "referred"] as const).map((side) => (
          <section key={side}>
            <h3>
              {side === "referrer" ? "Пригласившему" : "Приглашённому другу"}
            </h3>
            <Field label="Название награды">
              <input
                required
                maxLength={120}
                value={rewards[side].title}
                onChange={(e) =>
                  setRewards({
                    ...rewards,
                    [side]: { ...rewards[side], title: e.target.value },
                  })
                }
              />
            </Field>
            <Field label="Условия получения и использования">
              <textarea
                required
                maxLength={2000}
                rows={3}
                value={rewards[side].terms}
                onChange={(e) =>
                  setRewards({
                    ...rewards,
                    [side]: { ...rewards[side], terms: e.target.value },
                  })
                }
              />
            </Field>
          </section>
        ))}
        <Field label="Причина изменения">
          <textarea name="reason" required minLength={3} maxLength={1000} />
        </Field>
        {preview && (
          <div role="status">
            <h3>Проверьте перед публикацией</h3>
            <p>
              {enabled
                ? "Программа будет включена"
                : "Новые ручные награды создаваться не будут. Ранее возникшие сохранятся."}
            </p>
            <p>
              Пригласившему: {rewards.referrer.title} — {rewards.referrer.terms}
            </p>
            <p>
              Другу: {rewards.referred.title} — {rewards.referred.terms}
            </p>
          </div>
        )}
        <FormMessage error={error} />
        <button className="button" disabled={busy}>
          {busy && <Spinner />}
          {preview ? "Опубликовать условия" : "Проверить условия"}
        </button>
      </fieldset>
    </form>
  );
}
function IssueAward({
  selected,
  onClose,
  onDone,
}: {
  selected: { award: ReferralAward; name: string; car: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  return (
    <Dialog title="Выдача награды" onClose={onClose} protectChanges busy={busy}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            await command(
              `admin/referral-awards/${selected.award.id}/issue`,
              {
                comment: String(f.get("comment")),
                confirmed: f.has("confirmed"),
              },
              "POST",
              key,
            );
            onDone();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          <strong>{selected.name}</strong> · {selected.car}
        </p>
        <h3>{selected.award.title}</h3>
        <p>{selected.award.terms}</p>
        <Field label="Комментарий о выдаче">
          <textarea name="comment" required minLength={3} maxLength={1000} />
        </Field>
        <label className="checkbox-field">
          <input name="confirmed" type="checkbox" required />
          Подтверждаю, что награда фактически выдана
        </label>
        <FormMessage error={error} />
        <button className="button" disabled={busy}>
          {busy && <Spinner />}Отметить выдачу
        </button>
      </form>
    </Dialog>
  );
}
