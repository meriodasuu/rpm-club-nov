"use client";
import { useRef, useState } from "react";
import { api, command, Failure, Field, FormMessage, Loading, useResource } from "@/components/shared";
import { effectiveOdds, parseOddsPercent } from "@/lib/roulette/odds";
import { TIER_CODES } from "@/lib/loyalty/rules";
import { CustomerPicker } from "./customer-picker";
import type { Row } from "./tables";

type OddsPrize = Parameters<typeof effectiveOdds>[0][number] & { title: string };
type Promo = { id: string; code_hint: string; label: string; starts_at: string; expires_at: string; max_redemptions: number; redeemed_count: number; active: boolean; version: number };
type BulkPreview = { programVersion: number; recipients: number; attempts: number; expiresInDays: number; tiers: { code: string; name: string; count: number; amount: number; recipients: number; attempts: number }[] };

function BulkCreditsPanel({ onIssued }: { onIssued: () => Promise<void> }) {
  const tierInfo = useResource<BulkPreview>("admin/roulette/credits/bulk/preview?mode=tiers&amounts=%7B%7D");
  const history = useResource<{ items: { batch_id: string; actor_id: string; reason: string; created_at: string; result: BulkPreview }[] }>("admin/roulette/credits/bulk");
  const [mode, setMode] = useState<"all" | "tiers">("all");
  const [amount, setAmount] = useState(1);
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [result, setResult] = useState<BulkPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef<string | null>(null);
  function change() { setPreview(null); setResult(null); key.current = null; setError(""); }
  const validAmounts = mode === "all" ? Number.isInteger(amount) && amount >= 1 && amount <= 100 : Object.values(amounts).every((n) => Number.isInteger(n) && n >= 0 && n <= 100);
  async function check() {
    setBusy(true); setError(""); setResult(null);
    try {
      const params = new URLSearchParams({ mode, ...(mode === "all" ? { amount: String(amount) } : { amounts: JSON.stringify(amounts) }) });
      setPreview(await api<BulkPreview>(`admin/roulette/credits/bulk/preview?${params}`));
    } catch (e) { setError((e as Error).message); setPreview(null); }
    finally { setBusy(false); }
  }
  async function issue() {
    if (!preview) return;
    key.current ??= crypto.randomUUID(); setBusy(true); setError("");
    try {
      const issued = await command<BulkPreview>("admin/roulette/credits/bulk", { mode, ...(mode === "all" ? { amount } : { amounts }), reason: reason.trim(), expectedVersion: preview.programVersion }, "POST", key.current);
      setResult(issued); setPreview(null); key.current = null; await Promise.all([onIssued(), history.refresh()]);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="offer-admin-card form-stack" style={{ padding: 18 }}>
    <h2>Выдать участникам клуба</h2>
    <p className="small-note">Начислим попытки активным участникам. Telegram для этого не нужен.</p>
    <Field label="Как выдать"><select value={mode} disabled={busy} onChange={(e) => { setMode(e.target.value as "all" | "tiers"); change(); }}><option value="all">Одинаково всем</option><option value="tiers">По уровням клуба</option></select></Field>
    {mode === "all" ? <Field label="Попыток каждому"><input type="number" min="1" max="100" value={amount} disabled={busy} onChange={(e) => { setAmount(Number(e.target.value)); change(); }} /></Field> : <>
      <p>Укажите число попыток каждому участнику уровня. Ноль — пропустить уровень.</p>
      {tierInfo.error ? <Failure error={tierInfo.error} retry={tierInfo.refresh} /> : !tierInfo.data ? <Loading /> : tierInfo.data.tiers.map((tier) => <Field key={tier.code} label={`${tier.name} · ${tier.count} участников`}><input type="number" min="0" max="100" value={amounts[tier.code] ?? 0} disabled={busy} onChange={(e) => { setAmounts((old) => ({ ...old, [tier.code]: Number(e.target.value) })); change(); }} /></Field>)}
    </>}
    <Field label="Причина выдачи"><textarea minLength={10} maxLength={500} value={reason} disabled={busy} onChange={(e) => { setReason(e.target.value); change(); }} placeholder="Например, подарок участникам клуба" /></Field>
    <button type="button" className="button button-outline" disabled={busy || !validAmounts || reason.trim().length < 10} onClick={() => void check()}>{busy ? "Проверяем…" : "Проверить выдачу"}</button>
    {preview && <div role="status"><strong>{preview.recipients} участников · {preview.attempts} попыток</strong><p>Срок действия — {preview.expiresInDays} дней. Состав участников проверится при подтверждении.</p><ul>{preview.tiers.filter((t) => t.amount > 0).map((t) => <li key={t.code}>{t.name}: {t.recipients} × {t.amount} = {t.attempts}</li>)}</ul><button type="button" className="button" disabled={busy || !preview.recipients} onClick={() => void issue()}>Подтвердить выдачу</button></div>}
    {result && <p role="status">Выдано: {result.recipients} участников, {result.attempts} попыток.</p>}
    <details><summary>История массовой выдачи</summary>{history.error ? <Failure error={history.error} retry={history.refresh} /> : history.data?.items.length ? history.data.items.map((entry) => <p key={entry.batch_id}>{new Date(entry.created_at).toLocaleString("ru-RU")} · {entry.result.recipients} участников · {entry.result.attempts} попыток · {entry.reason} · {entry.actor_id}</p>) : <p>Массовых выдач пока нет.</p>}</details>
    <FormMessage error={error} />
  </div>;
}

export function RouletteOddsPanel({ version, canEdit, onSaved }: { version: number; canEdit: boolean; onSaved: () => Promise<void> }) {
  const r = useResource<{ items: OddsPrize[] }>("admin/roulette/odds");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [tier, setTier] = useState<string>("MEMBER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items = r.data?.items ?? [];
  const baseTotal = items.reduce((sum, p) => sum + p.weight, 0);
  const shares = items.map((p, i) => {
    const initial = baseTotal ? i === items.length - 1 ? 10000 - items.slice(0, -1).reduce((sum, x) => sum + Math.round(x.weight / baseTotal * 10000), 0) : Math.round(p.weight / baseTotal * 10000) : 0;
    const text = draft[p.id] ?? (initial / 100).toFixed(2);
    return { ...p, text, weight: parseOddsPercent(text) ?? 0 };
  });
  const total = shares.reduce((sum, p) => sum + p.weight, 0);
  const invalid = shares.some((p) => p.weight === 0);
  const preview = invalid ? [] : effectiveOdds(shares, tier);
  return <section className="offer-admin-card" style={{ padding: 18, marginBottom: 24 }}>
    <h2>Шансы призов</h2>
    <p className="small-note">Задайте долю каждого опубликованного приза. Сумма — 100%. Для участника шансы пересчитываются, если приз недоступен по уровню, сроку или лимиту.</p>
    {r.error ? <Failure error={r.error} retry={r.refresh} /> : !r.data ? <Loading /> : !items.length ? <p>Опубликуйте хотя бы один приз, чтобы настроить шансы.</p> : <>
      <div className="form-stack">
        {shares.map((p) => <Field key={p.id} label={`${p.title}, %`} hint={p.issue_cap && p.issued_count >= p.issue_cap ? "Лимит выдач исчерпан" : undefined}>
          <input type="text" inputMode="decimal" value={p.text} aria-invalid={p.weight === 0} disabled={!canEdit || busy} onChange={(e) => { setDraft((old) => ({ ...old, [p.id]: e.target.value })); setError(""); }} onBlur={() => { if (p.weight) setDraft((old) => ({ ...old, [p.id]: (p.weight / 100).toFixed(2) })); }} />
        </Field>)}
      </div>
      <p role="status">Итого: {(total / 100).toFixed(2)}%{invalid ? " · Введите шанс от 0,01 до 100 с точностью до сотых." : total !== 10000 ? " · Для сохранения сумма должна быть 100%." : " · Можно сохранить."}</p>
      <Field label="Посмотреть шансы для уровня">
        <select value={tier} onChange={(e) => setTier(e.target.value)}>{TIER_CODES.map((value) => <option key={value} value={value}>{value}</option>)}</select>
      </Field>
      {invalid ? null : preview.length ? <ul>{preview.map((p) => <li key={p.id}>{items.find((item) => item.id === p.id)?.title}: {p.percent.toFixed(2)}%</li>)}</ul> : <p role="alert">Для этого уровня нет доступных призов.</p>}
      <FormMessage error={error} />
      {canEdit && <button type="button" className="button" disabled={busy || total !== 10000 || invalid} onClick={async () => {
        setBusy(true); setError("");
        try {
          await command("admin/roulette/odds", { shares: shares.map((p) => ({ id: p.id, basisPoints: p.weight })), expectedVersion: version }, "PATCH", crypto.randomUUID());
          setDraft({}); await r.refresh(); await onSaved();
        } catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
      }}>{busy ? "Сохраняем…" : "Сохранить шансы"}</button>}
    </>}
  </section>;
}

export function RouletteCreditsPanel({ canEdit }: { canEdit: boolean }) {
  const promos = useResource<{ items: Promo[] }>("admin/roulette/promos");
  const credits = useResource<{ items: { id: string; user_id: string; source_type: string; granted: number; consumed: number; reason: string; created_at: string }[] }>("admin/roulette/credits");
  const [member, setMember] = useState<Row | null>(null);
  const [amount, setAmount] = useState(1);
  const [reason, setReason] = useState("");
  const [label, setLabel] = useState("");
  const [expires, setExpires] = useState("");
  const [maxUses, setMaxUses] = useState(100);
  const [createdCode, setCreatedCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const manualKey = useRef<string | null>(null);
  const promoKey = useRef<string | null>(null);
  return <section className="form-stack" style={{ marginBottom: 24 }}>
    {canEdit && <BulkCreditsPanel onIssued={credits.refresh} />}
    <div className="offer-admin-card" style={{ padding: 18 }}>
      <h2>Ручная выдача</h2>
      <p className="small-note">Выберите участника, число попыток и укажите причину. Каждая выдача записывается в журнал.</p>
      {canEdit ? <div className="form-stack">
        <CustomerPicker onSelect={(value) => { setMember(value); manualKey.current = null; }} />
        <Field label="Попыток"><input type="number" min="1" max="100" value={amount} onChange={(e) => { setAmount(Number(e.target.value)); manualKey.current = null; }} /></Field>
        <Field label="Причина"><textarea minLength={10} maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); manualKey.current = null; }} /></Field>
        <button type="button" className="button" disabled={busy || !member || amount < 1 || amount > 100 || reason.trim().length < 10} onClick={async () => {
          manualKey.current ??= crypto.randomUUID(); setBusy(true); setError("");
          try { await command("admin/roulette/credits", { userId: String(member!.id), amount, reason: reason.trim() }, "POST", manualKey.current); manualKey.current = null; setReason(""); await credits.refresh(); }
          catch (e) { setError((e as Error).message); } finally { setBusy(false); }
        }}>Выдать попытки</button>
      </div> : <p>Ручная выдача доступна администратору.</p>}
    </div>
    <div className="offer-admin-card" style={{ padding: 18 }}>
      <h2>Промокоды</h2>
      <p className="small-note">Один участник может применить код один раз. Каждое применение даёт один прокрут.</p>
      {canEdit && <div className="form-stack">
        <Field label="Название акции"><input value={label} maxLength={100} onChange={(e) => { setLabel(e.target.value); promoKey.current = null; }} placeholder="Например, Открытие клуба" /></Field>
        <Field label="Действует до (Москва)"><input type="datetime-local" value={expires} onChange={(e) => { setExpires(e.target.value); promoKey.current = null; }} /></Field>
        <Field label="Максимум применений"><input type="number" min="1" max="1000000" value={maxUses} onChange={(e) => { setMaxUses(Number(e.target.value)); promoKey.current = null; }} /></Field>
        <button type="button" className="button" disabled={busy || label.trim().length < 2 || !expires || maxUses < 1} onClick={async () => {
          promoKey.current ??= crypto.randomUUID(); setBusy(true); setError("");
          try { const result = await command<{ code: string }>("admin/roulette/promos", { label: label.trim(), startsAt: new Date().toISOString(), expiresAt: new Date(expires + ":00+03:00").toISOString(), maxRedemptions: maxUses }, "POST", promoKey.current); promoKey.current = null; setCreatedCode(result.code); setLabel(""); await promos.refresh(); }
          catch (e) { setError((e as Error).message); } finally { setBusy(false); }
        }}>Создать промокод</button>
        {createdCode && <p role="status">Сохраните код сейчас: <strong>{createdCode}</strong>. Повторно он не показывается.</p>}
      </div>}
      {promos.error ? <Failure error={promos.error} retry={promos.refresh} /> : !promos.data ? <Loading /> : promos.data.items.length ? <div className="form-stack">{promos.data.items.map((promo) => <div key={promo.id} className="detail-actions"><span><strong>{promo.label}</strong> · …{promo.code_hint} · {promo.redeemed_count}/{promo.max_redemptions} · {promo.active ? "Активен" : "Выключен"}</span>{canEdit && <button type="button" className="button button-outline" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await command(`admin/roulette/promos/${promo.id}`, { active: !promo.active, expectedVersion: promo.version }, "PATCH"); await promos.refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{promo.active ? "Выключить" : "Включить"}</button>}</div>)}</div> : <p>Промокодов пока нет.</p>}
    </div>
    <details className="offer-admin-card" style={{ padding: 18 }}><summary>История начисления попыток</summary>
      {credits.error ? <Failure error={credits.error} retry={credits.refresh} /> : !credits.data ? <Loading /> : credits.data.items.length ? credits.data.items.map((credit) => <p key={credit.id}>{new Date(credit.created_at).toLocaleString("ru-RU")} · {credit.source_type} · {credit.granted - credit.consumed} из {credit.granted} осталось · {credit.user_id}</p>) : <p>Начислений пока нет.</p>}
    </details>
    <FormMessage error={error} />
  </section>;
}
