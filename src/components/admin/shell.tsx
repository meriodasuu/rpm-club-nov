"use client";
import Link from "next/link";
import { BrowserAccess } from "./browser-access";
import { confirmUnsavedExit, UnsavedChangesPrompt } from "./unsaved";
import { usePathname, useRouter } from "next/navigation";
import {
  House,
  UsersRound,
  CarFront,
  Gift,
  Gem,
  ChartNoAxesColumnIncreasing,
  UserRoundPlus,
  Upload,
  Settings2,
  ClipboardList,
  Shield,
  Radio,
  Map,
  BookOpen,
  Bell,
  LogOut,
  Menu,
  Warehouse,
} from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import {
  Brand,
  Loading,
  Failure,
  command,
  useResource,
  Dialog,
} from "@/components/shared";
export type StaffView = {
  can_manage_staff?: boolean;
  id: string;
  name: string;
  role: "admin" | "manager" | "viewer";
  email: string | null;
};
const nav = [
  ["dashboard", "Обзор", House],
  ["customers", "Клиенты", UsersRound],
  ["rentals", "Аренды", CarFront],
  ["requests", "Заявки", ClipboardList],
  ["fleet", "Автопарк", Warehouse],
  ["routes", "Маршруты", Map],
  ["wiki", "База знаний", BookOpen],
  ["triggers", "Автоуведомления", Bell],
  ["transactions", "Bonus", Gift],
  ["offers", "Предложения", Gem],
  ["tiers", "Уровни", ChartNoAxesColumnIncreasing],
  ["referrals", "Приглашения друзей", UserRoundPlus],
  ["import", "Импорт", Upload],
  ["settings", "Настройки", Settings2],
  ["audit", "Журнал действий", ClipboardList],
  ["deliveries", "Доставка сообщений", Radio],
  ["team", "Сотрудники", Shield],
] as const;
const groups = [
  [
    "Работа с клиентами",
    ["dashboard", "customers", "rentals", "requests", "import"],
  ],
  ["Контент клуба", ["fleet", "routes", "wiki", "offers"]],
  ["Программа", ["tiers", "referrals", "transactions"]],
  ["Управление", ["settings", "triggers", "deliveries", "audit", "team"]],
] as const;
function AdminNavigation({
  staff,
  pathname,
  onNavigate,
}: {
  staff: StaffView;
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="admin-nav" aria-label="Панель управления">
      {groups.map(([group, keys]) => {
        const items = keys
          .flatMap((key) => nav.filter((item) => item[0] === key))
          .filter(
            ([key]) =>
              staff.role === "admin" ||
              !["settings", "audit", "team", "deliveries", "triggers"].includes(
                key,
              ),
          );
        if (!items.length) return null;
        return (
          <Fragment key={group}>
            <span className="admin-nav-group">{group}</span>
            {items.map(([key, label, Icon]) => (
              <Link
                key={key}
                href={"/admin/" + key}
                className={pathname.startsWith("/admin/" + key) ? "active" : ""}
                aria-current={
                  pathname.startsWith("/admin/" + key) ? "page" : undefined
                }
                title={label}
                onClick={onNavigate}
              >
                <Icon />
                <span>{label}</span>
              </Link>
            ))}
          </Fragment>
        );
      })}
    </nav>
  );
}
export function AdminShell({
  children,
  section,
}: {
  children: (staff: StaffView) => ReactNode;
  section: string;
}) {
  const {
    data: staff,
    error,
    loading,
    refresh,
  } = useResource<StaffView>("admin/me");
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  if (loading) return <Loading />;
  if (error || !staff)
    return (
      <main className="standalone">
        <Failure error={error ?? new Error("Нет доступа")} retry={refresh} />
      </main>
    );
  return (
    <div className="admin-layout">
      <UnsavedChangesPrompt />
      <aside className="admin-sidebar">
        <Brand />
        <span className="sidebar-caption">УПРАВЛЕНИЕ</span>
        <AdminNavigation staff={staff} pathname={pathname} />
        <div className="staff-card">
          <div className="avatar">
            {staff.name
              .split(" ")
              .slice(0, 2)
              .map((w) => w[0])
              .join("")}
          </div>
          <div>
            <strong>{staff.name}</strong>
            <small>
              {staff.role === "admin"
                ? "Администратор"
                : staff.role === "manager"
                  ? "Менеджер"
                  : "Просмотр"}
            </small>
          </div>
          <button
            className="icon-button"
            aria-label="Выйти"
            onClick={async () => {
              if (!(await confirmUnsavedExit())) return;
              await command("auth/staff/logout", {});
              router.replace("/admin/login");
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-topbar">
          <button
            type="button"
            className="button button-outline admin-menu-toggle"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={18} />
            Меню
          </button>
          <div>
            <Link href="/admin/dashboard">Клуб</Link> / &nbsp;
            {nav.find((n) => n[0] === section)?.[1] ?? "Карточка клиента"}
          </div>
          <BrowserAccess />
          {staff.can_manage_staff && (
            <Link
              href="/admin/team#add-admin"
              className="button staff-add-shortcut"
            >
              <UserRoundPlus size={18} />
              Добавить админа
            </Link>
          )}
          <Link href="/home" className="text-link">
            Открыть Mini App ↗
          </Link>
        </header>
        <div className="admin-content">{children(staff)}</div>
      </main>
      {menuOpen && (
        <Dialog
          title="Меню управления"
          protectChanges={false}
          onClose={() => setMenuOpen(false)}
        >
          <div className="admin-mobile-menu">
            <AdminNavigation
              staff={staff}
              pathname={pathname}
              onNavigate={() => setMenuOpen(false)}
            />
            <button
              type="button"
              className="button button-outline"
              onClick={async () => {
                if (!(await confirmUnsavedExit())) return;
                await command("auth/staff/logout", {});
                router.replace("/admin/login");
              }}
            >
              Выйти из админки
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
