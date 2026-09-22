"use client";
import Link from "next/link";
import {
  actionLabel,
  eventLabel,
  staffRoleLabel,
  maintenanceStageLabel,
} from "@/lib/admin-labels";
import { useState, useEffect } from "react";
import {
  Plus,
  Upload,
  Search,
  ArrowUpRight,
  RotateCcw,
  ChevronRight,
} from "lucide-react";
import {
  useResource,
  Loading,
  Failure,
  Empty,
  TierBadge,
  Field,
  FormMessage,
  command,
} from "@/components/shared";
import { money, date, labels } from "@/lib/ui";
import { AdminShell, type StaffView } from "./shell";
import {
  DataTable,
  PageHeading,
  Stats,
  Pagination,
  CustomerCells,
  RentalCells,
  TransactionCells,
  type Row,
} from "./tables";
import { FinanceDialog, type FinanceAction } from "./forms";
import { MembershipCard } from "@/components/miniapp/app";
import type { AccountSnapshot, Program } from "@/lib/loyalty/types";
import { resolveTierBenefits, tierName } from "@/lib/loyalty/rules";
import { ImportPage } from "./imports";
import { OffersPage } from "./offers";
import { ReferralsPage } from "./referrals";
import { SettingsPage } from "./settings";
import { TeamPage } from "./team";
import { ClubContentPage, RentalRequestsPage, TriggerRulesPage } from "./club";

export function AdminApp({
  section,
  customerId,
}: {
  section: string;
  customerId?: string;
}) {
  return (
    <AdminShell section={section}>
      {(staff) =>
        customerId ? (
          <CustomerDetail id={customerId} staff={staff} />
        ) : section === "dashboard" ? (
          <Dashboard />
        ) : section === "customers" ? (
          <Customers staff={staff} />
        ) : section === "rentals" || section === "transactions" ? (
          <OperationsList key={section} section={section} staff={staff} />
        ) : section === "import" ? (
          <ImportPage staff={staff} />
        ) : section === "offers" ? (
          <OffersPage staff={staff} />
        ) : section === "settings" ? (
          <SettingsPage />
        ) : section === "tiers" ? (
          <TiersPage staff={staff} />
        ) : section === "referrals" ? (
          <ReferralsPage staff={staff} />
        ) : section === "audit" ? (
          <AuditPage />
        ) : section === "deliveries" ? (
          <DeliveriesPage />
        ) : section === "team" ? (
          <TeamPage />
        ) : section === "fleet" ||
          section === "routes" ||
          section === "wiki" ? (
          <ClubContentPage
            key={section}
            kind={
              section === "fleet"
                ? "car"
                : section === "routes"
                  ? "route"
                  : "wiki"
            }
            staff={staff}
          />
        ) : section === "requests" ? (
          <RentalRequestsPage staff={staff} />
        ) : section === "triggers" ? (
          <TriggerRulesPage />
        ) : (
          <Empty title="Раздел не найден" />
        )
      }
    </AdminShell>
  );
}
function Dashboard() {
  const { data, error, loading, refresh } = useResource<{
    stats: Row;
    distribution: Row[];
    recent: Row[];
    program: Program;
  }>("admin/dashboard");
  if (loading) return <Loading />;
  if (error || !data)
    return <Failure error={error ?? new Error("Нет данных")} retry={refresh} />;
  return (
    <>
      <PageHeading
        title="Обзор клуба"
        subtitle="Аренды, участники и программа в цифрах"
      >
        <Link href="/admin/import" className="button button-outline">
          <Upload size={17} />
          Импортировать
        </Link>
        <Link href="/admin/customers" className="button">
          Клиенты
          <ArrowUpRight size={18} />
        </Link>
      </PageHeading>
      <Stats stats={data.stats} />
      <p className="small-note">
        За всё время · Заблокировано участников:{" "}
        {String(data.stats.blocked_members ?? 0)}. Сумма аренд учитывает отмены
        и корректировки.
      </p>
      <div className="two-columns">
        <section className="panel">
          <div className="panel-header">
            <h2>Уровни участников</h2>
            <span className="muted">RPM Club</span>
          </div>
          <div className="panel-body distribution">
            {data.program.tiers.map((t) => {
              const count = Number(
                  data.distribution.find((d) => d.tier === t.code)?.count ?? 0,
                ),
                total = Number(data.stats.members) || 1;
              return (
                <div className="distribution-row" key={t.code}>
                  <span>{tierName(t)}</span>
                  <div className="progress-track">
                    <span style={{ width: (100 * count) / total + "%" }} />
                  </div>
                  <span>{count}</span>
                </div>
              );
            })}
          </div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <h2>RPM Bonus</h2>
            <Link
              href="/admin/transactions"
              className="icon-button"
              aria-label="История Bonus"
            >
              <ArrowUpRight size={18} />
            </Link>
          </div>
          <div className="panel-body">
            <dl className="profile-details">
              <div>
                <dt>Начислено по программе</dt>
                <dd>{money(String(data.stats.gross_credits ?? 0), false)}</dd>
              </div>
              <div>
                <dt>Перенесённый начальный баланс</dt>
                <dd>{money(String(data.stats.opening_balance ?? 0), false)}</dd>
              </div>
              <div>
                <dt>Использовано для аренды</dt>
                <dd>{money(String(data.stats.redeemed), false)}</dd>
              </div>
              <div>
                <dt>Сгорело</dt>
                <dd>{money(String(data.stats.expired), false)}</dd>
              </div>
              <div>
                <dt>Ручные списания</dt>
                <dd>{money(String(data.stats.manual_debits ?? 0), false)}</dd>
              </div>
              <div>
                <dt>Возврат Bonus при отменах</dt>
                <dd>
                  +{money(String(data.stats.reversal_credits ?? 0), false)}
                </dd>
              </div>
              <div>
                <dt>Компенсация начислений</dt>
                <dd>
                  −{money(String(data.stats.reversal_debits ?? 0), false)}
                </dd>
              </div>
              <div>
                <dt>Итог проводок с учётом отмен</dt>
                <dd>{money(String(data.stats.net_bonus ?? 0), false)}</dd>
              </div>
            </dl>
            <p className="small-note">
              Итог проводок = доступный баланс − внутренний дефицит. Сгорание и
              отмена сгорания показаны раздельно.
            </p>
          </div>
        </section>
      </div>
      <section className="panel">
        <div className="panel-header">
          <h2>Сумма аренд и корректировки</h2>
        </div>
        <div className="panel-body">
          <dl className="profile-details">
            <div>
              <dt>Исходная сумма учтённых аренд</dt>
              <dd>{money(String(data.stats.gross_rental_amount ?? 0))}</dd>
            </div>
            <div>
              <dt>Снижения и отмены к исходной сумме</dt>
              <dd>−{money(String(data.stats.rental_reductions ?? 0))}</dd>
            </div>
            <div>
              <dt>Повышения к исходной сумме</dt>
              <dd>+{money(String(data.stats.rental_increases ?? 0))}</dd>
            </div>
            <div>
              <dt>Текущая сумма завершённых аренд</dt>
              <dd>{money(String(data.stats.total_amount ?? 0))}</dd>
            </div>
          </dl>
        </div>
      </section>
      <section className="panel">
        <div className="panel-header">
          <h2>Последние аренды</h2>
          <Link className="text-link" href="/admin/rentals">
            Все аренды
            <ChevronRight size={16} />
          </Link>
        </div>
        <DataTable
          headings={["Автомобиль", "Участник", "Завершение", "Сумма", "Статус"]}
          rows={data.recent}
          render={(r) => <RentalCells row={r} />}
        />
      </section>
    </>
  );
}
function Customers({ staff }: { staff: StaffView }) {
  const [q, setQ] = useState(""),
    [query, setQuery] = useState(""),
    [tier, setTier] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(0),
    [dialog, setDialog] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(q);
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  const { data, error, refresh } = useResource<{ items: Row[]; total: number }>(
    `admin/customers?q=${encodeURIComponent(query)}&tier=${tier}&status=${status}&page=${page}`,
  );
  const { data: dashboard, refresh: refreshStats } = useResource<{
    stats: Row;
    program: Program;
  }>("admin/dashboard");
  return (
    <>
      <PageHeading title="Клиенты" subtitle="Люди, которые выбирают RPM">
        {staff.role !== "viewer" && (
          <>
            <Link className="button button-outline" href="/admin/import">
              <Upload size={17} />
              Импортировать
            </Link>
            <button className="button" onClick={() => setDialog(true)}>
              <Plus size={19} />
              Добавить аренду
            </button>
          </>
        )}
      </PageHeading>
      {dashboard && <Stats stats={dashboard.stats} />}
      <section className="panel">
        <div className="filters">
          <div className="search-input">
            <Search />
            <input
              aria-label="Поиск клиентов"
              placeholder="Имя, телефон или Member ID"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select
            aria-label="Уровень клиента"
            value={tier}
            onChange={(e) => {
              setTier(e.target.value);
              setPage(0);
            }}
          >
            <option value="">Все уровни</option>
            {dashboard?.program.tiers.map((t) => (
              <option key={t.code} value={t.code}>
                {tierName(t)}
              </option>
            ))}
          </select>
          <select
            aria-label="Статус клиента"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(0);
            }}
          >
            <option value="">Все статусы</option>
            <option value="active">Активен</option>
            <option value="pending">Не активирован</option>
            <option value="blocked">Заблокирован</option>
          </select>
        </div>
        {error ? (
          <Failure error={error} retry={refresh} />
        ) : !data ? (
          <Loading />
        ) : (
          <>
            <DataTable
              headings={[
                "Участник",
                "Уровень",
                "Аренды",
                "Сумма аренд",
                "Bonus",
                "Статус",
                "",
              ]}
              rows={data.items}
              render={(r) => (
                <CustomerCells row={r} tiers={dashboard?.program.tiers} />
              )}
              empty="Участники не найдены"
            />
            <Pagination
              page={page}
              onChange={setPage}
              hasNext={(page + 1) * 50 < data.total}
              total={data.total}
            />
          </>
        )}
      </section>
      {dialog && (
        <FinanceDialog
          action="rental"
          onClose={() => setDialog(false)}
          onDone={() => {
            void refresh();
            void refreshStats();
          }}
        />
      )}
    </>
  );
}
function OperationsList({
  section,
  staff,
}: {
  section: "rentals" | "transactions";
  staff: StaffView;
}) {
  const [page, setPage] = useState(0),
    [dialog, setDialog] = useState<{
      action: FinanceAction;
      id?: string;
      rental?: Row;
    } | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const params = new URLSearchParams({ ...filters, page: String(page) });
  const { data, error, refresh } = useResource<{ items: Row[]; total: number }>(
    `admin/${section}?${params}`,
  );
  const rentals = section === "rentals";
  const { data: program } = useResource<Program>("admin/tiers");
  return (
    <>
      <PageHeading
        title={rentals ? "Аренды" : "RPM Bonus"}
        subtitle={
          rentals
            ? program?.rewardMode === "discount"
              ? "Стоимость указывается после скидок. Завершённые оплаченные поездки обновляют уровень."
              : program
                ? "Bonus начисляются после завершения и полной оплаты поездки"
                : "Статусы поездок, оплата и стоимость аренды"
            : "Каждое движение Bonus — отдельная операция"
        }
      >
        {staff.role !== "viewer" && (
          <>
            {!rentals && (
              <button
                className="button button-outline"
                onClick={() => setDialog({ action: "redeem" })}
              >
                Применить к аренде
              </button>
            )}
            <button
              className="button"
              onClick={() =>
                setDialog({ action: rentals ? "rental" : "credit" })
              }
            >
              <Plus size={18} />
              {rentals ? "Добавить аренду" : "Начислить Bonus"}
            </button>
          </>
        )}
      </PageHeading>
      <section className="panel">
        <form
          className="filters"
          style={{ flexWrap: "wrap", alignItems: "end" }}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setFilters(
              Object.fromEntries(
                [...form.entries()].map(([key, value]) => [key, String(value)]),
              ),
            );
            setPage(0);
          }}
        >
          {rentals ? (
            <>
              <Field label="Статус аренды">
                <select name="status">
                  <option value="">Все статусы</option>
                  {["accepted", "in_progress", "completed", "cancelled"].map(
                    (value) => (
                      <option value={value} key={value}>
                        {labels[value]}
                      </option>
                    ),
                  )}
                </select>
              </Field>
              <Field label="Оплата">
                <select name="payment_status">
                  <option value="">Любая оплата</option>
                  {["paid", "unpaid", "partial", "refunded"].map((value) => (
                    <option value={value} key={value}>
                      {labels[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Источник">
                <input
                  name="source"
                  maxLength={128}
                  placeholder="Например, manual или rpm"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Тип Bonus">
                <select name="type">
                  <option value="">Все операции</option>
                  {[
                    "rental_cashback",
                    "referral_reward",
                    "manual_credit",
                    "manual_debit",
                    "rental_payment",
                    "expiration",
                    "reversal",
                  ].map((value) => (
                    <option value={value} key={value}>
                      {labels[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Клиент">
                <input
                  name="q"
                  placeholder="Имя, телефон или Member ID"
                  maxLength={200}
                />
              </Field>
            </>
          )}
          <Field label={rentals ? "Завершение с" : "Операции с (Москва)"}>
            <input type="date" name="date_from" />
          </Field>
          <Field label="По включительно">
            <input type="date" name="date_to" />
          </Field>
          <button className="button button-small" type="submit">
            Применить
          </button>
          <button
            className="button button-small button-outline"
            type="reset"
            onClick={() => {
              setFilters({});
              setPage(0);
            }}
          >
            Сбросить
          </button>
        </form>
        {error ? (
          <Failure error={error} retry={refresh} />
        ) : !data ? (
          <Loading />
        ) : (
          <>
            <DataTable
              headings={
                rentals
                  ? [
                      "Автомобиль",
                      "Участник",
                      "Завершение",
                      "Сумма",
                      "Статус",
                      ...(staff.role !== "viewer" ? ["Действия"] : []),
                    ]
                  : [
                      "Операция",
                      "Участник",
                      "Bonus",
                      "Остаток",
                      "Действуют до",
                      "Связь с операцией",
                      ...(staff.role !== "viewer" ? ["Действия"] : []),
                    ]
              }
              rows={data.items}
              render={(r) =>
                rentals ? (
                  <RentalCells
                    row={r}
                    action={
                      staff.role !== "viewer" ? (
                        <div className="detail-actions">
                          {r.status === "accepted" &&
                            r.mode === "operational" && (
                              <button
                                className="text-link"
                                onClick={() =>
                                  setDialog({
                                    action: "pickup",
                                    id: String(r.id),
                                    rental: r,
                                  })
                                }
                              >
                                Время выдачи
                              </button>
                            )}
                          {r.status !== "cancelled" && (
                            <button
                              className="text-link"
                              onClick={() =>
                                setDialog({
                                  action: "status",
                                  id: String(r.id),
                                  rental: r,
                                })
                              }
                            >
                              Статус
                            </button>
                          )}
                          {r.status !== "cancelled" && (
                            <button
                              className="text-link"
                              onClick={() =>
                                setDialog({
                                  action: "adjust",
                                  id: String(r.id),
                                })
                              }
                            >
                              Сумма
                            </button>
                          )}
                          {r.status !== "cancelled" && (
                            <button
                              className="icon-button"
                              aria-label="Отменить аренду"
                              onClick={() =>
                                setDialog({
                                  action: "cancel",
                                  id: String(r.id),
                                })
                              }
                            >
                              <RotateCcw size={15} />
                            </button>
                          )}
                        </div>
                      ) : undefined
                    }
                  />
                ) : (
                  <TransactionCells
                    row={r}
                    showActions={staff.role !== "viewer"}
                    action={
                      staff.role !== "viewer" &&
                      [
                        "manual_credit",
                        "manual_debit",
                        "rental_payment",
                      ].includes(String(r.type)) &&
                      BigInt(String(r.reversible_amount ?? r.amount ?? 0)) !==
                        0n ? (
                        <button
                          className="text-link"
                          onClick={() =>
                            setDialog({ action: "reverse", id: String(r.id) })
                          }
                        >
                          Отменить
                        </button>
                      ) : undefined
                    }
                  />
                )
              }
            />
            <Pagination
              page={page}
              onChange={setPage}
              hasNext={data.items.length === 50}
              total={data.total}
            />
          </>
        )}
      </section>
      {dialog && (
        <FinanceDialog
          action={dialog.action}
          entityId={dialog.id}
          rental={dialog.rental}
          onClose={() => setDialog(null)}
          onDone={() => void refresh()}
        />
      )}
    </>
  );
}
function CustomerDetail({ id, staff }: { id: string; staff: StaffView }) {
  const { data, error, loading, refresh } = useResource<{
    snapshot: AccountSnapshot;
    rentals: { items: Row[] };
    transactions: { items: Row[] };
    referrals: Row[];
    crmCustomerId: string | null;
    crmIdentities: Row[];
  }>(`admin/customers/${id}`);
  const [dialog, setDialog] = useState<FinanceAction | null>(null);
  if (loading) return <Loading />;
  if (error || !data)
    return (
      <Failure
        error={error ?? new Error("Участник не найден")}
        retry={refresh}
      />
    );
  const a = data.snapshot;
  return (
    <>
      <Link
        href="/admin/customers"
        className="text-link"
        style={{ marginBottom: 20 }}
      >
        ← Все участники
      </Link>
      <PageHeading title={a.user.name} subtitle={a.user.public_member_id}>
        {staff.role !== "viewer" && (
          <>
            <button
              className="button button-outline"
              onClick={() => setDialog("redeem")}
            >
              Применить Bonus
            </button>
            <button className="button" onClick={() => setDialog("rental")}>
              <Plus size={18} />
              Добавить аренду
            </button>
          </>
        )}
      </PageHeading>
      <div className="customer-detail-grid">
        <aside>
          <MembershipCard account={a} />
          <section className="panel">
            <div className="panel-header">
              <h2>Профиль участника</h2>
            </div>
            <div className="panel-body">
              <dl className="profile-details">
                <div>
                  <dt>Телефон</dt>
                  <dd>{a.user.phone ?? "Не указан"}</dd>
                </div>
                <div>
                  <dt>Telegram</dt>
                  <dd>
                    {a.user.telegram_username
                      ? "@" + a.user.telegram_username
                      : (a.user.telegram_id ?? "Не связан")}
                  </dd>
                </div>
                <div>
                  <dt>Дата вступления</dt>
                  <dd>{date(a.member_since)}</dd>
                </div>
                <div>
                  <dt>Статус</dt>
                  <dd>{labels[a.user.status]}</dd>
                </div>
                <div>
                  <dt>Referral</dt>
                  <dd>{a.user.referral_code}</dd>
                </div>
                <div>
                  <dt>CRM ID</dt>
                  <dd>{data.crmCustomerId ?? "Не указан"}</dd>
                </div>
                {data.crmIdentities.map((identity) => (
                  <div
                    key={
                      String(identity.source) + String(identity.crm_customer_id)
                    }
                  >
                    <dt>CRM · {String(identity.source)}</dt>
                    <dd>{String(identity.crm_customer_id)}</dd>
                  </div>
                ))}
              </dl>
              {staff.role === "admin" && (
                <div className="detail-actions" style={{ marginTop: 22 }}>
                  <Link
                    className="button button-small button-outline"
                    href={`/admin/customers/${id}/identity`}
                  >
                    Данные участника
                  </Link>
                  <button
                    className="button button-small button-outline"
                    onClick={() => setDialog("tier")}
                  >
                    Изменить уровень
                  </button>
                  <button
                    className="button button-small button-outline"
                    onClick={() =>
                      setDialog(
                        a.user.status === "blocked" ? "restore" : "block",
                      )
                    }
                  >
                    {a.user.status === "blocked"
                      ? "Восстановить"
                      : "Заблокировать"}
                  </button>
                </div>
              )}
            </div>
          </section>
        </aside>
        <div>
          <section className="panel">
            <div className="panel-body metric-inline">
              <div>
                <span>Сумма завершённых аренд</span>
                <strong>{money(a.total_rental_amount)}</strong>
              </div>
              <div>
                <span>Доступно Bonus</span>
                <strong>{money(a.bonus_available, false)}</strong>
              </div>
              <div>
                <span>
                  {a.next_tier
                    ? "До " +
                      tierName(
                        a.program.tiers.find((t) => t.code === a.next_tier)!,
                      )
                    : "Статус"}
                </span>
                <strong>
                  {a.remaining_amount
                    ? money(a.remaining_amount)
                    : "Максимальный"}
                </strong>
              </div>
            </div>
            {a.bonus_debt !== "0" && (
              <p className="form-error">
                Корректировка: {money(a.bonus_debt, false)} Bonus будут покрыты
                будущими начислениями.
              </p>
            )}
          </section>
          <section className="panel">
            <div className="panel-header">
              <h2>Аренды</h2>
            </div>
            <DataTable
              headings={[
                "Автомобиль",
                "Начало",
                "Завершение",
                "Сумма",
                "Статус",
              ]}
              rows={data.rentals.items}
              render={(r) => <RentalCells row={r} />}
            />
          </section>
          <section className="panel">
            <div className="panel-header">
              <h2>История Bonus</h2>
              {staff.role !== "viewer" && (
                <div className="detail-actions">
                  <button
                    className="text-link"
                    onClick={() => setDialog("credit")}
                  >
                    Начислить
                  </button>
                  <button
                    className="text-link"
                    onClick={() => setDialog("debit")}
                  >
                    Списать
                  </button>
                </div>
              )}
            </div>
            <DataTable
              headings={[
                "Операция",
                "Дата",
                "Bonus",
                "Остаток",
                "Действуют до",
                "Связь с операцией",
              ]}
              rows={data.transactions.items}
              render={(r) => <TransactionCells row={r} />}
            />
          </section>
          <section className="panel">
            <div className="panel-header">
              <h2>Приглашения</h2>
            </div>
            <DataTable
              headings={[
                "Пригласил",
                "Приглашённый",
                "Статус",
                "Награды",
                "Основание",
              ]}
              rows={data.referrals}
              empty="Приглашений пока нет"
              render={(r) => (
                <>
                  <td>
                    <Link href={`/admin/customers/${r.referrer_id}`}>
                      {String(r.referrer_name)}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/admin/customers/${r.referred_id}`}>
                      {String(r.referred_name)}
                    </Link>
                  </td>
                  <td>{labels[String(r.status)] ?? String(r.status)}</td>
                  <td>
                    {r.referrer_reward == null
                      ? "После первой аренды"
                      : `${money(String(r.referrer_reward), false)} / ${money(String(r.referred_reward), false)}`}
                  </td>
                  <td>
                    {r.reason === "blocked_hold"
                      ? "На проверке после блокировки"
                      : String(r.reason ?? "—")}
                  </td>
                </>
              )}
            />
          </section>
        </div>
      </div>
      {dialog && (
        <FinanceDialog
          action={dialog}
          userId={id}
          onClose={() => setDialog(null)}
          onDone={() => void refresh()}
        />
      )}
    </>
  );
}
function TiersPage({ staff }: { staff: StaffView }) {
  const { data, error } = useResource<Program>("admin/tiers");
  return (
    <>
      <PageHeading
        title="Уровни RPM Club"
        subtitle={
          data
            ? `Уровней: ${data.tiers.length}. Достигнутый статус сохраняется.`
            : "Достигнутый статус сохраняется."
        }
      >
        {staff.role === "admin" && (
          <Link href="/admin/settings" className="button button-outline">
            Изменить уровни
          </Link>
        )}
      </PageHeading>
      {error ? (
        <Failure error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <section className="panel">
          <DataTable
            headings={[
              "Уровень",
              "Сумма аренд от",
              data.rewardMode === "discount" ? "Скидка" : "Cashback",
              "Привилегии",
            ]}
            rows={data.tiers.map((t) => ({
              ...t,
              id: t.code,
              name: tierName(t),
              benefits: resolveTierBenefits(data.tiers, t.code),
            }))}
            render={(r) => (
              <>
                <td>
                  <TierBadge tier={String(r.code)} label={String(r.name)} />
                </td>
                <td>{money(String(r.thresholdKopecks))}</td>
                <td>{Number(r.rateBps) / 100}%</td>
                <td>
                  <div className="table-primary">
                    {(r.benefits as string[]).map((b) => (
                      <span key={b}>{b}</span>
                    ))}
                  </div>
                </td>
              </>
            )}
          />
        </section>
      )}
    </>
  );
}
function AuditPage() {
  const [page, setPage] = useState(0),
    [expanded, setExpanded] = useState<string | null>(null);
  const { data, error } = useResource<{ items: Row[] }>(
    `admin/audit?page=${page}`,
  );
  return (
    <>
      <PageHeading
        title="Журнал действий"
        subtitle="Неизменяемая история операций сотрудников и системы"
      />
      <section className="panel">
        {error ? (
          <Failure error={error} />
        ) : !data ? (
          <Loading />
        ) : (
          <>
            <DataTable
              headings={["Когда", "Кто", "Действие", "Основание", "Изменения"]}
              rows={data.items}
              render={(r) => (
                <>
                  <td>
                    {date(String(r.created_at))}
                    <small className="muted">
                      <br />
                      {new Date(String(r.created_at)).toLocaleTimeString(
                        "ru-RU",
                      )}
                    </small>
                  </td>
                  <td>
                    <span className="table-primary">
                      {String(
                        r.actor_name ||
                          (r.actor_role === "system"
                            ? "Система"
                            : r.actor_role === "integration"
                              ? "Интеграция"
                              : "Сотрудник"),
                      )}
                      <small>{staffRoleLabel(String(r.actor_role))}</small>
                    </span>
                  </td>
                  <td>{actionLabel(String(r.action))}</td>
                  <td>{String(r.reason)}</td>
                  <td>
                    <button
                      className="text-link"
                      onClick={() =>
                        setExpanded(expanded === r.id ? null : String(r.id))
                      }
                    >
                      {expanded === r.id ? "Скрыть" : "До / после"}
                    </button>
                    {expanded === r.id && (
                      <pre className="code-cell">
                        {JSON.stringify(
                          {
                            actorId: r.actor_id,
                            action: r.action,
                            before: r.before_data,
                            after: r.after_data,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    )}
                  </td>
                </>
              )}
            />
            <Pagination
              page={page}
              onChange={setPage}
              hasNext={data.items.length === 50}
            />
          </>
        )}
      </section>
    </>
  );
}
function DeliveriesPage() {
  const { data, error, refresh } = useResource<{
    items: Row[];
    errors: Row[];
    maintenance: { at: string } | null;
  }>("admin/deliveries", 30000);
  const [message, setMessage] = useState("");
  return (
    <>
      <PageHeading
        title="Доставка сообщений и диагностика"
        subtitle="Telegram и фоновые задания"
      />
      <FormMessage error={message} />
      {data?.maintenance && (
        <p className="small-note">
          Последнее успешное обслуживание: {date(data.maintenance.at)}
        </p>
      )}
      {error ? (
        <Failure error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <section className="panel">
            <DataTable
              headings={[
                "Канал",
                "Получатель / сообщение",
                "Состояние",
                "Попытки",
                "Следующая попытка",
                "Ошибка",
                "",
              ]}
              rows={data.items}
              render={(r) => (
                <>
                  <td>{String(r.channel)}</td>
                  <td>
                    {String(
                      r.recipient_name || "Получатель не связан с участником",
                    )}
                    <small className="muted">
                      {eventLabel(String(r.event_type))}
                    </small>
                  </td>
                  <td>{labels[String(r.status)] ?? String(r.status)}</td>
                  <td>{String(r.attempts)}</td>
                  <td>{date(String(r.next_attempt_at))}</td>
                  <td>
                    {r.last_error ? (
                      <details>
                        <summary>Не удалось доставить сообщение</summary>
                        <code>{String(r.last_error)}</code>
                      </details>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {["dead", "retry"].includes(String(r.status)) && (
                      <button
                        className="text-link"
                        onClick={async () => {
                          try {
                            await command(`admin/deliveries/${r.id}/retry`, {});
                            await refresh();
                          } catch (e) {
                            setMessage((e as Error).message);
                          }
                        }}
                      >
                        Повторить
                      </button>
                    )}
                  </td>
                </>
              )}
            />
          </section>
          {data.errors.length > 0 && (
            <section className="panel">
              <div className="panel-header">
                <h2>Требует внимания</h2>
              </div>
              <DataTable
                headings={["Тип", "Данные", "Дата"]}
                rows={data.errors}
                render={(r) => (
                  <>
                    <td>
                      {r.kind === "job_maintenance"
                        ? "Фоновое обслуживание"
                        : String(r.kind)}
                    </td>
                    <td>
                      {r.kind === "job_maintenance" && (
                        <p>
                          {maintenanceStageLabel(
                            String((r.details as Row)?.stage ?? "unknown"),
                          )}
                        </p>
                      )}
                      <details>
                        <summary>Технические подробности</summary>
                        <pre className="code-cell">
                          {JSON.stringify(r.details, null, 2)}
                        </pre>
                      </details>
                    </td>
                    <td>{date(String(r.created_at))}</td>
                  </>
                )}
              />
            </section>
          )}
        </>
      )}
    </>
  );
}
