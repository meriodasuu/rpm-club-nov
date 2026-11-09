"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  UsersRound,
  UserRoundPlus,
  CarFront,
  Gift,
} from "lucide-react";
import { money, date, labels } from "@/lib/ui";
import { Empty, TierBadge } from "@/components/shared";
import { tierName, type TierRule } from "@/lib/loyalty/rules";
export type Row = Record<string, unknown>;
export function PageHeading({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="page-heading-actions">{children}</div>}
    </div>
  );
}
export function Stats({ stats }: { stats: Row }) {
  const fields = [
    ["Участники клуба", String(stats.members ?? 0), UsersRound],
    ["Новые за 30 дней", "+" + String(stats.new_members ?? 0), UserRoundPlus],
    ["Сумма аренд", money(String(stats.total_amount ?? 0)), CarFront],
    ["Доступно Bonus", money(String(stats.available_bonus ?? 0), false), Gift],
  ] as const;
  return (
    <div className="stats-grid">
      {fields.map(([label, value, Icon]) => (
        <div className="stat-card" key={label}>
          <Icon />
          <div>
            <span className="stat-label">{label}</span>
            <strong className="stat-value">{value}</strong>
          </div>
        </div>
      ))}
    </div>
  );
}
export function DataTable({
  headings,
  rows,
  render,
  empty = "Записей пока нет",
}: {
  headings: string[];
  rows: Row[];
  render: (row: Row) => ReactNode;
  empty?: string;
}) {
  if (!rows.length) return <Empty title={empty} />;
  return (
    <div className="data-table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {headings.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={String(row.id ?? row.row_number ?? i)}>{render(row)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Pagination({
  page,
  onChange,
  hasNext,
  total,
}: {
  page: number;
  onChange: (page: number) => void;
  hasNext: boolean;
  total?: number;
}) {
  return (
    <div className="table-footer">
      <span>
        {total !== undefined
          ? `Всего записей: ${total}`
          : "Страница " + (page + 1)}
      </span>
      <div className="pagination">
        <button
          disabled={page === 0}
          onClick={() => onChange(page - 1)}
          aria-label="Предыдущая страница"
        >
          <ChevronLeft size={17} />
        </button>
        <span>{page + 1}</span>
        <button
          disabled={!hasNext}
          onClick={() => onChange(page + 1)}
          aria-label="Следующая страница"
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}
export function Person({ row }: { row: Row }) {
  return (
    <Link href={"/admin/customers/" + row.id} className="person-cell">
      <span className="avatar">
        {String(row.name)
          .split(" ")
          .slice(0, 2)
          .map((x) => x[0])
          .join("")}
      </span>
      <span>
        <strong>{String(row.name)}</strong>
        <small>{String(row.phone || row.public_member_id || "")}</small>
      </span>
    </Link>
  );
}
export function CustomerCells({
  row,
  tiers,
}: {
  row: Row;
  tiers?: TierRule[];
}) {
  const tier = tiers?.find((t) => t.code === row.tier);
  return (
    <>
      <td>
        <Person row={row} />
      </td>
      <td>
        <TierBadge
          tier={String(row.tier)}
          label={tier ? tierName(tier) : undefined}
        />
      </td>
      <td>{String(row.rental_count)}</td>
      <td className="number">{money(String(row.total_rental_amount))}</td>
      <td className="number">{money(String(row.bonus_available), false)}</td>
      <td>
        <span className={"status-dot " + row.status}>
          {labels[String(row.status)]}
        </span>
      </td>
      <td>
        <Link
          href={"/admin/customers/" + row.id}
          className="icon-button"
          aria-label={"Открыть " + row.name}
        >
          <ChevronRight size={17} />
        </Link>
      </td>
    </>
  );
}
export function RentalCells({ row, action }: { row: Row; action?: ReactNode }) {
  return (
    <>
      <td>
        <span className="table-primary">
          <strong>{String(row.car_name)}</strong>
          <small>
            {String(row.external_rental_id)} · {String(row.source ?? "—")}
          </small>
          {row.pickup_at ? (
            <small>
              Выдача:{" "}
              {new Date(String(row.pickup_at)).toLocaleString("ru-RU", {
                timeZone: "Europe/Moscow",
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              (Москва)
            </small>
          ) : row.status === "accepted" ? (
            <small>Время выдачи не указано</small>
          ) : null}
        </span>
      </td>
      <td>
        {row.customer_name ? (
          <Link href={"/admin/customers/" + row.user_id}>
            {String(row.customer_name)}
          </Link>
        ) : (
          date(String(row.start_date))
        )}
      </td>
      <td>
        {row.status === "completed" && row.completed_at
          ? new Date(String(row.completed_at)).toLocaleString("ru-RU", {
              timeZone: "Europe/Moscow",
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : date(String(row.end_date))}
      </td>
      <td className="number">
        {money(String(row.current_amount_kopecks ?? row.amount_kopecks))}
      </td>
      <td>
        <span className="table-primary">
          {labels[String(row.status)]}
          <small>{labels[String(row.payment_status)]}</small>
        </span>
      </td>
      {action && <td>{action}</td>}
    </>
  );
}
export function TransactionCells({
  row,
  action,
  showActions = false,
}: {
  row: Row;
  action?: ReactNode;
  showActions?: boolean;
}) {
  return (
    <>
      <td>
        <span className="table-primary">
          <strong>{labels[String(row.type)] ?? String(row.type)}</strong>
          <small>{String(row.reason)}</small>
          <small title={String(row.id)}>{String(row.id).slice(0, 8)}</small>
        </span>
      </td>
      <td>
        {row.customer_name ? (
          <span className="table-primary">
            <Link href={"/admin/customers/" + row.user_id}>
              {String(row.customer_name)}
            </Link>
            <small>{date(String(row.created_at))}</small>
          </span>
        ) : (
          date(String(row.created_at))
        )}
      </td>
      <td
        className={
          "number " + (BigInt(String(row.amount ?? 0)) > 0n ? "positive" : "")
        }
      >
        {BigInt(String(row.amount ?? 0)) > 0n ? "+" : ""}
        {money(String(row.amount ?? 0), false)}
      </td>
      <td className="number">
        {row.remaining_amount == null
          ? "—"
          : money(String(row.remaining_amount), false)}
      </td>
      <td>{row.expires_at ? date(String(row.expires_at)) : "—"}</td>
      <td>
        <span className="table-primary">
          {row.reverses_id ? (
            <span title={String(row.reverses_id)}>
              Отмена {String(row.reverses_id).slice(0, 8)}
            </span>
          ) : (
            "—"
          )}
          {BigInt(String(row.reversed_amount ?? 0)) > 0n && (
            <small>
              Компенсировано: {money(String(row.reversed_amount), false)}
            </small>
          )}
        </span>
      </td>
      {showActions && <td>{action ?? <span className="muted">—</span>}</td>}
    </>
  );
}
