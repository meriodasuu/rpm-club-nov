"use client";
import { useState, useRef } from "react";
import {
  useResource,
  Loading,
  Failure,
  Field,
  FormMessage,
  Spinner,
  command,
} from "@/components/shared";
import { PageHeading, DataTable, type Row } from "./tables";
import type { Program } from "@/lib/loyalty/types";
import {
  CARD_COLORS,
  TIER_CODES,
  tierColor,
  tierName,
  resolveProgramStartsAt,
  type TierRule,
} from "@/lib/loyalty/rules";
import { date, rublesInput } from "@/lib/ui";
import { useUnsavedChanges } from "./unsaved";
export function SettingsPage() {
  const r = useResource<{ program: Program; settings: Row[]; versions: Row[] }>(
    "admin/settings",
  );
  return (
    <>
      <PageHeading
        title="Настройки программы"
        subtitle="Новая редакция применяется к следующим операциям"
      >
        <a href="#legal-documents" className="button button-outline">
          Правила и согласия
        </a>
      </PageHeading>
      {r.error ? (
        <Failure error={r.error} />
      ) : !r.data ? (
        <Loading />
      ) : (
        <>
          <ProgramForm
            key={r.data.program.id}
            program={r.data.program}
            onDone={() => void r.refresh()}
          />
          <section className="panel">
            <div className="panel-header">
              <h2>История редакций</h2>
            </div>
            <DataTable
              headings={["Версия", "Дата публикации"]}
              rows={r.data.versions}
              render={(v) => (
                <>
                  <td>RPM Club · v{String(v.version)}</td>
                  <td>{date(String(v.effective_at))}</td>
                </>
              )}
            />
          </section>
          <LegalEditor />
        </>
      )}
    </>
  );
}
function ProgramForm({
  program,
  onDone,
}: {
  program: Program;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<{ upgrades: number; items: Row[] } | null>(
      null,
    );
  const formRef = useRef<HTMLFormElement>(null);
  const guard = useUnsavedChanges();
  const thresholdsRevision = useRef(0);
  const [tiers, setTiers] = useState<TierRule[]>(program.tiers);
  const [rewardMode, setRewardMode] = useState(
    program.rewardMode ?? "cashback",
  );
  return (
    <form
      ref={formRef}
      onChange={(e) => {
        guard.markDirty();
        const target = e.target;
        if (
          target instanceof HTMLInputElement &&
          target.name.endsWith("-threshold")
        ) {
          thresholdsRevision.current++;
          setPreview(null);
        }
      }}
      className="panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const f = new FormData(e.currentTarget),
            value = (k: string) => String(f.get(k) ?? "");
          await command("admin/program-versions", {
            rewardMode,
            tiers: tiers.map((t) => ({
              code: t.code,
              displayName: value(t.code + "-name"),
              color: value(t.code + "-color"),
              thresholdKopecks: rublesInput(value(t.code + "-threshold")),
              rateBps: Math.round(Number(value(t.code + "-rate")) * 100),
              benefits: value(t.code + "-benefits")
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            })),
            redemptionLimitBps: Math.round(Number(value("limit")) * 100),
            expiryDays: Number(value("expiry")),
            referrerReward: value("referrer"),
            referredReward: value("referred"),
            programStartsAt: resolveProgramStartsAt(
              value("start"),
              program.programStartsAt,
            ),
            reason: value("reason"),
          });
          guard.markSaved();
          onDone();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="panel-header">
        <h2>RPM Club · версия {program.version}</h2>
        <span className="small-note">Достигнутые уровни сохраняются</span>
      </div>
      <fieldset className="panel-body" disabled={busy}>
        <p className="small-note" id="program-publish-steps">
          1. Измените условия. 2. Проверьте влияние порогов. 3. Укажите причину,
          подтвердите и опубликуйте редакцию.
        </p>
        <Field label="Механика программы">
          <select
            value={rewardMode}
            onChange={(e) =>
              setRewardMode(e.target.value as "cashback" | "discount")
            }
          >
            <option value="cashback">Cashback в Bonus</option>
            <option value="discount">Скидка на аренду</option>
          </select>
        </Field>
        <p className="small-note">
          Скидка фиксируется при заявке и уменьшает стоимость аренды. В режиме
          скидок новые аренды не приносят cashback. Прежние Bonus и история
          сохраняются. Процент применяется только после публикации редакции.
        </p>
        {!tiers.some((t) => t.code === "PLATINUM") && (
          <button
            type="button"
            className="button button-outline"
            onClick={() => {
              const next: TierRule = {
                code: "PLATINUM",
                thresholdKopecks: "",
                rateBps: 0,
                benefits: [],
                color: "diamond",
              };
              setTiers(
                [...tiers, next].sort(
                  (a, b) =>
                    TIER_CODES.indexOf(a.code) - TIER_CODES.indexOf(b.code),
                ),
              );
              setPreview(null);
              thresholdsRevision.current++;
              guard.markDirty();
            }}
          >
            Добавить шестой уровень
          </button>
        )}
        {tiers.map((t) => (
          <section className="settings-tier" key={t.code}>
            <h3>{t.code}</h3>
            <div className="form-grid">
              <Field label="Название карты">
                <input
                  name={t.code + "-name"}
                  defaultValue={tierName(t)}
                  maxLength={30}
                  required
                />
              </Field>
              <Field label="Цвет карты">
                <select name={t.code + "-color"} defaultValue={tierColor(t)}>
                  {CARD_COLORS.map((c, i) => (
                    <option key={c} value={c}>
                      {
                        [
                          "Бронза",
                          "Серебро",
                          "Золото",
                          "Бриллиант",
                          "Red",
                          "Чёрный",
                        ][i]
                      }
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="form-grid">
              <Field label="Сумма аренд от, ₽">
                <input
                  name={t.code + "-threshold"}
                  defaultValue={
                    t.thresholdKopecks
                      ? String(Number(t.thresholdKopecks) / 100)
                      : ""
                  }
                  inputMode="decimal"
                  required
                />
              </Field>
              <Field
                label={rewardMode === "discount" ? "Скидка, %" : "Cashback, %"}
              >
                <input
                  name={t.code + "-rate"}
                  type="number"
                  min={0}
                  max={rewardMode === "discount" ? 99.99 : 100}
                  step="0.01"
                  defaultValue={t.rateBps / 100}
                  required
                />
              </Field>
            </div>
            <Field label="Привилегии · каждая с новой строки">
              <textarea
                name={t.code + "-benefits"}
                rows={3}
                defaultValue={t.benefits.join("\n")}
              />
            </Field>
          </section>
        ))}
        <div className="form-grid">
          <Field label="Максимальная оплата Bonus, %">
            <input
              name="limit"
              type="number"
              min={0}
              max={100}
              step="0.01"
              defaultValue={program.redemptionLimitBps / 100}
              required
            />
          </Field>
          <Field label="Срок действия Bonus, дней">
            <input
              name="expiry"
              type="number"
              min={1}
              max={3650}
              defaultValue={program.expiryDays}
              required
            />
          </Field>
          <Field label="Прежняя программа: пригласившему, Bonus">
            <input
              name="referrer"
              readOnly
              inputMode="decimal"
              defaultValue={program.referrerReward}
              required
            />
          </Field>
          <Field label="Прежняя программа: приглашённому, Bonus">
            <input
              name="referred"
              readOnly
              inputMode="decimal"
              defaultValue={program.referredReward}
              required
            />
          </Field>
          <Field label="Начало программы · Москва">
            <input
              name="start"
              type="date"
              defaultValue={new Date(
                new Date(program.programStartsAt).getTime() + 3 * 3600000,
              )
                .toISOString()
                .slice(0, 10)}
              required
            />
          </Field>
        </div>
        <p className="small-note">
          Новые награды настраиваются в разделе «Приглашения друзей». Значения
          Bonus выше сохранены для прежней программы.
        </p>
        <Field label="Причина изменения">
          <textarea name="reason" required minLength={3} maxLength={1000} />
        </Field>
        <label className="checkbox-field">
          <input type="checkbox" required />
          Подтверждаю публикацию новой редакции. Прошлые начисления сохранят
          свои условия.
        </label>
        <FormMessage error={error} />
        {!preview && (
          <p className="small-note" role="status">
            Для публикации сначала нажмите «Проверить влияние порогов».
          </p>
        )}
        <button
          type="button"
          className="button button-outline"
          disabled={busy}
          onClick={async () => {
            if (!formRef.current) return;
            setBusy(true);
            setError("");
            try {
              const f = new FormData(formRef.current);
              const revision = thresholdsRevision.current;
              const result = await command<{ upgrades: number; items: Row[] }>(
                "admin/program-preview",
                {
                  tiers: tiers.map((t) => ({
                    code: t.code,
                    thresholdKopecks: rublesInput(
                      String(f.get(t.code + "-threshold")),
                    ),
                  })),
                },
              );
              if (revision === thresholdsRevision.current) setPreview(result);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Проверить влияние порогов
        </button>
        {preview && (
          <div style={{ margin: "20px 0" }}>
            <p className="small-note">
              Повышений: {preview.upgrades}. Понижений: 0. Расчёт на текущих
              данных, до публикации аренды могут изменить результат.
            </p>
            <DataTable
              headings={["Сейчас", "После пересчёта", "Участников"]}
              rows={preview.items}
              render={(r) => (
                <>
                  <td>{String(r.before_tier)}</td>
                  <td>{String(r.after_tier)}</td>
                  <td>{String(r.count)}</td>
                </>
              )}
            />
          </div>
        )}
        <button
          className="button"
          style={{ marginLeft: 12 }}
          disabled={busy || !preview}
          aria-describedby="program-publish-steps"
        >
          {busy && <Spinner />}Опубликовать редакцию
        </button>
      </fieldset>
    </form>
  );
}
function LegalEditor() {
  const guard = useUnsavedChanges();
  const r = useResource<{ items: Row[] }>("admin/legal"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [success, setSuccess] = useState("");
  return (
    <section className="panel" id="legal-documents">
      <div className="panel-header">
        <h2>Правила и согласия</h2>
      </div>
      <div className="panel-body">
        <p className="small-note">
          Новая редакция сохраняется отдельно. Согласия участников остаются
          связаны с принятой ими версией.
        </p>
        <form
          onChange={guard.markDirty}
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget,
              f = new FormData(form);
            setBusy(true);
            setError("");
            try {
              await command("admin/legal", Object.fromEntries(f));
              form.reset();
              guard.markSaved();
              setSuccess("Редакция опубликована");
              void r.refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            <Field label="Документ">
              <select name="type">
                <option value="rules">Правила программы</option>
                <option value="privacy">Политика конфиденциальности</option>
                <option value="personal-data">
                  Обработка персональных данных
                </option>
              </select>
            </Field>
            <Field label="Версия">
              <input name="version" required maxLength={30} placeholder="1.0" />
            </Field>
          </div>
          <Field label="Заголовок">
            <input name="title" required maxLength={200} />
          </Field>
          <Field label="Текст документа">
            <textarea
              name="text"
              required
              minLength={20}
              maxLength={50000}
              rows={8}
            />
          </Field>
          <FormMessage error={error} success={success} />
          <button className="button button-outline" disabled={busy}>
            {busy && <Spinner />}Опубликовать документ
          </button>
        </form>
      </div>
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : (
        <DataTable
          headings={["Документ", "Версия", "Дата"]}
          rows={r.data.items}
          render={(d) => (
            <>
              <td>
                <a
                  href={
                    "/legal/" +
                    d.type +
                    "?version=" +
                    encodeURIComponent(String(d.version))
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  {String(d.title)}
                </a>
              </td>
              <td>{String(d.version)}</td>
              <td>{date(String(d.published_at))}</td>
            </>
          )}
        />
      )}
    </section>
  );
}
