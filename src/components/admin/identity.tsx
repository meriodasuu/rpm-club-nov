"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AdminShell } from "./shell";
import { PageHeading } from "./tables";
import {
  useResource,
  Loading,
  Failure,
  Field,
  FormMessage,
  Spinner,
  command,
} from "@/components/shared";
import type { AccountSnapshot } from "@/lib/loyalty/types";
export function IdentityPage({ id }: { id: string }) {
  return (
    <AdminShell section="customers">
      {(staff) =>
        staff.role === "admin" ? (
          <IdentityForm id={id} />
        ) : (
          <Failure
            error={
              new Error("Изменение идентичности доступно только администратору")
            }
          />
        )
      }
    </AdminShell>
  );
}
function IdentityForm({ id }: { id: string }) {
  const r = useResource<{ snapshot: AccountSnapshot }>("admin/customers/" + id),
    router = useRouter(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (r.error) return <Failure error={r.error} />;
  if (!r.data) return <Loading />;
  const a = r.data.snapshot;
  return (
    <>
      <Link href={"/admin/customers/" + id} className="text-link">
        ← Карточка клиента
      </Link>
      <PageHeading title="Данные участника" subtitle={a.user.name} />
      <form
        className="panel"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const f = new FormData(e.currentTarget);
          try {
            await command(`admin/customers/${id}/identity`, {
              name: f.get("name"),
              phone: f.get("phone") || null,
              telegramId: f.get("telegramId") || null,
              identityVerified: f.get("verified") === "on",
              expectedVersion: a.account_version,
              reason: f.get("reason"),
            });
            router.replace("/admin/customers/" + id);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="panel-body form-stack">
          <Field label="Имя">
            <input
              name="name"
              required
              maxLength={200}
              defaultValue={a.user.name}
            />
          </Field>
          <Field label="Телефон · E.164">
            <input name="phone" type="tel" defaultValue={a.user.phone ?? ""} />
          </Field>
          <Field label="Telegram ID">
            <input
              name="telegramId"
              inputMode="numeric"
              defaultValue={a.user.telegram_id ?? ""}
            />
          </Field>
          <Field label="Основание и способ проверки личности">
            <textarea name="reason" required minLength={10} maxLength={1000} />
          </Field>
          <label className="checkbox-field">
            <input name="verified" type="checkbox" required />
            Личность проверена вне приложения. Подтверждаю новые связи и отзыв
            прежних сессий.
          </label>
          <p className="small-note">
            Сумма аренд, Bonus и история сохраняются. Связать номер или Telegram
            другого клиента нельзя.
          </p>
          <FormMessage error={error} />
          <button className="button" disabled={busy}>
            {busy && <Spinner />}Сохранить и отозвать сессии
          </button>
        </div>
      </form>
    </>
  );
}
