"use client";
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  ApiError,
  command,
  Dialog,
  Failure,
  Field,
  FormMessage,
  Loading,
  useResource,
} from "@/components/shared";
import { ImageUpload } from "./image-upload";
import { PageHeading } from "./tables";
import type { StaffView } from "./shell";
import { RouletteCreditsPanel, RouletteOddsPanel } from "./roulette-controls";
import { RouletteAwardHistory } from "./roulette-awards";
import { effectiveOdds } from "@/lib/roulette/odds";
import { TIER_CODES } from "@/lib/loyalty/rules";

type Prize = {
  id: string;
  code: string;
  title: string;
  summary: string;
  terms: string;
  image_url: string;
  image_alt: string;
  effect_type: string;
  effect_value: number;
  weight: number;
  minimum_tier: string | null;
  car_ids: string[];
  min_days: number;
  max_days: number;
  min_total_kopecks: string;
  starts_at: string | null;
  ends_at: string | null;
  issue_cap: number | null;
  issued_count: number;
  active: boolean;
  archived_at: string | null;
  sort_order: number;
  version: number;
  updated_by?: string;
};
type Settings = {
  enabled: boolean;
  approved: boolean;
  serverApproved: boolean;
  registration_attempts: number;
  attempt_ttl_days: number;
  award_ttl_days: number;
  version: number;
};
const blank: Omit<Prize, "id" | "issued_count" | "archived_at" | "version"> = {
  code: "",
  title: "",
  summary: "",
  terms: "",
  image_url: "",
  image_alt: "",
  effect_type: "info",
  effect_value: 0,
  weight: 1,
  minimum_tier: null,
  car_ids: [],
  min_days: 1,
  max_days: 90,
  min_total_kopecks: "0",
  starts_at: null,
  ends_at: null,
  issue_cap: null,
  active: false,
  sort_order: 0,
};
const effectLabels: Record<string, string> = {
  percent: "Скидка, %",
  fixed: "Скидка, ₽",
  free_day: "Бесплатные дни",
  wash: "Мойка",
  upgrade: "Повышение класса",
  bonus: "RPM Bonus",
  info: "Информационный приз",
};
const prizeFieldNames: Record<string, string> = {
  code: "Код", title: "Название", summary: "Краткое описание", terms: "Полные условия",
  image_url: "Фото", image_alt: "Описание фото", effect_type: "Тип награды",
  effect_value: "Размер награды", minimum_tier: "Минимальный уровень", car_ids: "Автомобили",
  min_days: "Минимум дней", max_days: "Максимум дней", min_total_kopecks: "Минимальная сумма аренды",
  starts_at: "Доступен с", ends_at: "Доступен до", issue_cap: "Лимит выдач",
  active: "Публикация", sort_order: "Порядок",
};
export function prizeSaveError(error: unknown) {
  if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
    const fields = Object.entries(error.fieldErrors ?? {})
      .filter(([, messages]) => messages.length)
      .map(([field, messages]) => `${prizeFieldNames[field] ?? field}: ${messages[0]}`);
    return [...fields, ...(error.formErrors ?? [])].join(" · ") || error.message;
  }
  return error instanceof Error ? error.message : "Не удалось сохранить приз";
}
function moscowInput(value: string | null | undefined) {
  return value
    ? new Date(new Date(value).getTime() + 3 * 3600000)
        .toISOString()
        .slice(0, 16)
    : "";
}
function moscowIso(value: string) {
  return new Date(value + ":00+03:00").toISOString();
}

export function RouletteAdminPage({ staff }: { staff: StaffView }) {
  const prizes = useResource<{ items: Prize[] }>("admin/roulette/prizes");
  const cars = useResource<{ items: { id: string; title: string }[] }>(
    "club/content?kind=car",
  );
  const settings = useResource<Settings>("admin/roulette/settings");
  const spins = useResource<{
    items: {
      id: string;
      user_id: string;
      created_at: string;
      prize_snapshot: Prize;
      status: string;
      source_type: string | null;
      pool_snapshot: { id: string; weight: number }[] | null;
      random_ticket: number | null;
      random_total: number | null;
    }[];
    denials: { user_id: string; reason: string; created_at: string }[];
  }>("admin/roulette/spins");
  const [edit, setEdit] = useState<Partial<Prize> | null>(null);
  const [error, setError] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [busy, setBusy] = useState(false);
  const createKey = useRef<string | null>(null);
  const settingsKey = useRef<string | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null);
  const [historyFilter, setHistoryFilter] = useState("");
  const currentSettings = settingsDraft ?? settings.data;
  const launchBlockers = currentSettings ? [
    ...(!currentSettings.serverApproved ? ["На сервере не разрешён запуск. Требуется включить ROULETTE_ECONOMICS_APPROVED после утверждения экономики призов."] : []),
    ...(!currentSettings.approved ? ["Подтвердите экономические правила."] : []),
    ...(currentSettings.award_ttl_days < 1 ? ["Укажите срок действия награды больше нуля."] : []),
    ...(prizes.data?.items && TIER_CODES.some((tier) => effectiveOdds(prizes.data!.items, tier).length === 0) ? ["Опубликуйте хотя бы один доступный приз для каждого уровня клуба."] : []),
  ] : [];
  const observed = new Map<string, { expected: number; actual: number }>();
  for (const spin of spins.data?.items ?? []) {
    const total = spin.pool_snapshot?.reduce((sum, p) => sum + p.weight, 0) ?? 0;
    if (!total) continue;
    for (const candidate of spin.pool_snapshot ?? []) {
      const count = observed.get(candidate.id) ?? { expected: 0, actual: 0 };
      count.expected += candidate.weight / total;
      if (candidate.id === spin.prize_snapshot.id) count.actual++;
      observed.set(candidate.id, count);
    }
  }
  async function savePrize() {
    if (!edit) return;
    if (!edit.id) createKey.current ??= crypto.randomUUID();
    setBusy(true);
    setError("");
    try {
      await command(
        `admin/roulette/prizes${edit.id ? "/" + edit.id : ""}`,
        {
          ...blank,
          ...edit,
          expected_version: edit.version,
        },
        edit.id ? "PATCH" : "POST",
        createKey.current ?? undefined,
      );
      createKey.current = null;
      setEdit(null);
      await prizes.refresh();
    } catch (e) {
      setError(prizeSaveError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Рулетка призов"
        subtitle="Каталог и параметры выдачи в RPM CLUB"
      >
        <a className="button button-outline" href="#prize-history">История призов</a>
        {staff.role !== "viewer" && (
          <button
            type="button"
            className="button"
            onClick={() => setEdit({ ...blank })}
          >
            Создать приз
          </button>
        )}
      </PageHeading>
      {settings.error ? (
        <Failure error={settings.error} retry={settings.refresh} />
      ) : !currentSettings ? (
        <Loading />
      ) : (
        <section
          className="offer-admin-card"
          style={{ padding: 18, marginBottom: 24 }}
        >
          <h2>Состояние и правила рулетки</h2>
          <div className="roulette-admin-status" role="status">
            <strong>{currentSettings.enabled && !launchBlockers.length ? "Рулетка открыта участникам" : "Рулетка закрыта для участников"}</strong>
            {launchBlockers.length > 0 && <><p>Для запуска осталось:</p><ul>{launchBlockers.map((reason) => <li key={reason}>{reason}</li>)}</ul></>}
          </div>
          {staff.role === "admin" ? (
            <div className="form-stack">
              <Field label="Попытки за регистрацию" hint="Начисляются один раз после завершения регистрации. Ноль — выключено.">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={currentSettings.registration_attempts}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...currentSettings,
                      registration_attempts: Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Срок действия попытки, дней"><input type="number" min="1" max="365" value={currentSettings.attempt_ttl_days} onChange={(e) => setSettingsDraft({ ...currentSettings, attempt_ttl_days: Number(e.target.value) })} /></Field>
              <Field label="Срок награды, дней">
                <input
                  type="number"
                  min="0"
                  max="365"
                  value={currentSettings.award_ttl_days}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...currentSettings,
                      award_ttl_days: Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Подтверждение экономических правил">
                <input
                  type="checkbox"
                  checked={currentSettings.approved}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...currentSettings,
                      approved: e.target.checked,
                    })
                  }
                />
              </Field>
              <Field label="Открыть розыгрыш">
                <input
                  type="checkbox"
                  checked={currentSettings.enabled}
                  onChange={(e) =>
                    e.target.checked && launchBlockers.length
                      ? setSettingsError(launchBlockers.join(" "))
                      : (setSettingsError(""), setSettingsDraft({ ...currentSettings, enabled: e.target.checked }))
                  }
                />
              </Field>
              {settingsError && <div className="roulette-admin-error" role="alert">{settingsError}</div>}
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={async () => {
                  settingsKey.current ??= crypto.randomUUID();
                  setBusy(true);
                  setSettingsError("");
                  try {
                    if (currentSettings.enabled && launchBlockers.length) throw new Error(launchBlockers.join(" "));
                    await command(
                      "admin/roulette/settings",
                      {
                        ...currentSettings,
                        expected_version: settings.data?.version,
                      },
                      "PATCH",
                      settingsKey.current ?? undefined,
                    );
                    settingsKey.current = null;
                    setSettingsDraft(null);
                    await settings.refresh();
                  } catch (e) {
                    setSettingsError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Сохранить правила
              </button>
            </div>
          ) : (
            <p>
              {currentSettings.enabled ? "Открыта" : "Выключена"} ·{" "}
              {currentSettings.registration_attempts} попыток за регистрацию · срок награды {currentSettings.award_ttl_days} дней
            </p>
          )}
        </section>
      )}
      {settings.data && <RouletteOddsPanel version={settings.data.version} canEdit={staff.role === "admin"} onSaved={settings.refresh} />}
      <RouletteCreditsPanel canEdit={staff.role === "admin"} />
      <FormMessage error={error} />
      <h2>Призы</h2>
      {prizes.error ? (
        <Failure error={prizes.error} retry={prizes.refresh} />
      ) : prizes.loading ? (
        <Loading />
      ) : (
        <div className="offers-grid">
          {prizes.data?.items.map((p) => (
            <article
              key={p.id}
              className="offer-admin-card"
              style={{ padding: 16 }}
            >
              {p.image_url && (
                <img
                  src={p.image_url}
                  alt={p.image_alt}
                  style={{ width: "100%", height: 150, objectFit: "cover" }}
                />
              )}
              <h2>{p.title}</h2>
              <p>{p.summary}</p>
              <p>
                {p.archived_at
                  ? "Архив"
                  : p.active
                    ? "Опубликован"
                    : "Черновик"}{" "}
                · {effectLabels[p.effect_type]}
              </p>
              <p>
                Выдано: {p.issued_count}
                {p.issue_cap ? ` / ${p.issue_cap}` : ""}
              </p>
              {p.updated_by && (
                <p className="small-note">Изменил: {p.updated_by}</p>
              )}
              {staff.role !== "viewer" && !p.archived_at && (
                <>
                  <button
                    type="button"
                    className="button button-outline"
                    onClick={() => setEdit(p)}
                  >
                    Редактировать
                  </button>{" "}
                  <button
                    type="button"
                    className="button button-outline"
                    onClick={async () => {
                      if (!confirm(`Архивировать «${p.title}»?`)) return;
                      try {
                        await command(
                          `admin/roulette/prizes/${p.id}`,
                          { expected_version: p.version },
                          "DELETE",
                        );
                        await prizes.refresh();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Архивировать
                  </button>
                </>
              )}
            </article>
          ))}
        </div>
      )}
      <section id="prize-history" style={{ marginTop: 30 }}>
        <h2>История призов</h2>
        <p className="small-note">Выигрыши участников, сроки и подтверждённые активации.</p>
        <RouletteAwardHistory canRedeem={staff.role !== "viewer"} />
      </section>
      <section style={{ marginTop: 30 }}>
        <h2>Проверка розыгрышей</h2>
        <Field label="Поиск по дате, ID участника или призу">
          <input
            value={historyFilter}
            onChange={(e) => setHistoryFilter(e.target.value)}
          />
        </Field>
        {spins.error ? (
          <Failure error={spins.error} retry={spins.refresh} />
        ) : spins.data?.items.length ? (
          spins.data.items
            .filter((s) =>
              `${s.created_at} ${s.user_id} ${s.prize_snapshot.title}`
                .toLocaleLowerCase("ru-RU")
                .includes(historyFilter.toLocaleLowerCase("ru-RU")),
            )
            .map((s) => (
              <details key={s.id} className="panel panel-body">
                <summary>{new Date(s.created_at).toLocaleString("ru-RU")} · {s.prize_snapshot.title} · {s.status} · {s.user_id}</summary>
                <p>Источник попытки: {s.source_type ?? "Ранее выданная попытка"}</p>
                {s.random_ticket !== null && <p>Случайное число: {s.random_ticket} из {s.random_total}. Доступных призов: {s.pool_snapshot?.length ?? 0}.</p>}
              </details>
            ))
        ) : (
          <p>Розыгрышей пока нет.</p>
        )}
        {observed.size > 0 && <details className="panel panel-body"><summary>Распределение призов по последним {spins.data?.items.length ?? 0} прокрутам</summary><p className="small-note">Ожидание рассчитано по шансам на момент каждого прокрута. Малые выборки могут сильно отличаться.</p>{[...observed].map(([id, count]) => <p key={id}>{prizes.data?.items.find((p) => p.id === id)?.title ?? id}: ожидаемо {count.expected.toFixed(1)}, выпало {count.actual}</p>)}</details>}
        {!!spins.data?.denials?.length && <details className="panel panel-body"><summary>Отклонённые попытки ({spins.data.denials.length})</summary>{spins.data.denials.map((denial, i) => <p key={i}>{new Date(denial.created_at).toLocaleString("ru-RU")} · {denial.user_id} · {denial.reason}</p>)}</details>}
      </section>
      {edit && (
        <PrizeDialog
          value={edit}
          cars={cars.data?.items ?? []}
          carsError={cars.error}
          setValue={setEdit}
          busy={busy}
          error={error}
          onClose={() => setEdit(null)}
          onSave={savePrize}
        />
      )}
    </>
  );
}

function PrizeDialog({
  value,
  cars,
  carsError,
  setValue,
  busy,
  error,
  onClose,
  onSave,
}: {
  value: Partial<Prize>;
  cars: { id: string; title: string }[];
  carsError: Error | null;
  setValue: Dispatch<SetStateAction<Partial<Prize> | null>>;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const change = (patch: Partial<Prize>) =>
    setValue((previous) => (previous ? { ...previous, ...patch } : previous));
  const field = (label: string, key: keyof Prize, type = "text") => (
    <Field label={label}>
      <input
        type={type}
        value={String(value[key] ?? "")}
        onChange={(e) =>
          change({
            [key]:
              key === "issue_cap" && !e.target.value
                ? null
                : type === "number"
                  ? Number(e.target.value)
                  : e.target.value,
          })
        }
      />
    </Field>
  );
  return (
    <Dialog
      title={value.id ? "Редактировать приз" : "Новый приз"}
      onClose={onClose}
      busy={busy || uploading}
      protectChanges
    >
      <div className="form-stack">
        {value.id && <p className="small-note">Код приза: {value.code}</p>}
        {field("Название", "title")}
        {field("Краткое описание", "summary")}
        <Field label="Полные условия">
          <textarea
            value={value.terms ?? ""}
            onChange={(e) => change({ terms: e.target.value })}
            rows={5}
          />
        </Field>
        <ImageUpload
          value={value.image_url ?? ""}
          onChange={(image_url) =>
            setValue((previous) =>
              previous
                ? {
                    ...previous,
                    image_url,
                    image_alt:
                      previous.image_alt?.trim() ||
                      previous.title?.trim() ||
                      "",
                  }
                : previous,
            )
          }
          busy={uploading}
          onBusy={setUploading}
          allowUrl={false}
        />
        {field("Описание фото (для публикации)", "image_alt")}
        <Field label="Тип награды">
          <select
            value={value.effect_type}
            onChange={(e) =>
              change({ effect_type: e.target.value, effect_value: 0 })
            }
          >
            {Object.entries(effectLabels).map(([code, label]) => (
              <option value={code} key={code}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        {!["wash", "upgrade", "info"].includes(value.effect_type ?? "info") && (
          <Field
            label={
              value.effect_type === "percent"
                ? "Размер скидки, %"
                : value.effect_type === "fixed"
                  ? "Размер скидки, ₽"
                  : value.effect_type === "free_day"
                    ? "Бесплатных дней"
                    : "Количество Bonus"
            }
          >
            <input
              type="number"
              min={value.effect_type === "percent" ? "0.01" : "1"}
              step={
                value.effect_type === "percent" || value.effect_type === "fixed"
                  ? "0.01"
                  : "1"
              }
              value={
                value.effect_type === "percent" || value.effect_type === "fixed"
                  ? (value.effect_value ?? 0) / 100
                  : (value.effect_value ?? 0)
              }
              onChange={(e) =>
                change({
                  effect_value:
                    value.effect_type === "percent" ||
                    value.effect_type === "fixed"
                      ? Math.round(Number(e.target.value) * 100)
                      : Number(e.target.value),
                })
              }
            />
          </Field>
        )}
        <Field label="Минимальный уровень">
          <select
            value={value.minimum_tier ?? ""}
            onChange={(e) => change({ minimum_tier: e.target.value || null })}
          >
            <option value="">Любой</option>
            {["MEMBER", "DRIVE", "BLACK", "PLATINUM", "RED", "SIGNATURE"].map(
              (t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ),
            )}
          </select>
        </Field>
        <Field label="Автомобили (если не выбраны — любые)">
          <div className="form-stack">
            {carsError && (
              <p role="alert">
                Не удалось загрузить автопарк: {carsError.message}
              </p>
            )}
            {cars.map((car) => (
              <label key={car.id}>
                <input
                  type="checkbox"
                  checked={(value.car_ids ?? []).includes(car.id)}
                  onChange={(e) =>
                    change({
                      car_ids: e.target.checked
                        ? [...(value.car_ids ?? []), car.id]
                        : (value.car_ids ?? []).filter((id) => id !== car.id),
                    })
                  }
                />{" "}
                {car.title}
              </label>
            ))}
            {(value.car_ids ?? [])
              .filter((id) => !cars.some((car) => car.id === id))
              .map((id) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() =>
                      change({
                        car_ids: (value.car_ids ?? []).filter(
                          (carId) => carId !== id,
                        ),
                      })
                    }
                  />{" "}
                  Недоступный автомобиль ({id})
                </label>
              ))}
          </div>
        </Field>
        {field("Минимум дней", "min_days", "number")}
        {field("Максимум дней", "max_days", "number")}
        <Field label="Минимальная сумма аренды, ₽">
          <input
            type="number"
            min="0"
            step="0.01"
            value={Number(value.min_total_kopecks ?? "0") / 100}
            onChange={(e) =>
              change({
                min_total_kopecks: String(
                  Math.round(Number(e.target.value) * 100),
                ),
              })
            }
          />
        </Field>
        {field("Лимит выдач (пусто — без лимита)", "issue_cap", "number")}
        <Field label="Доступен с (Москва)">
          <input
            type="datetime-local"
            value={moscowInput(value.starts_at)}
            onChange={(e) =>
              change({
                starts_at: e.target.value ? moscowIso(e.target.value) : null,
              })
            }
          />
        </Field>
        <Field label="Доступен до (Москва)">
          <input
            type="datetime-local"
            value={moscowInput(value.ends_at)}
            onChange={(e) =>
              change({
                ends_at: e.target.value ? moscowIso(e.target.value) : null,
              })
            }
          />
        </Field>
        {field("Порядок", "sort_order", "number")}
        <Field label="Опубликовать">
          <input
            type="checkbox"
            checked={value.active ?? false}
            onChange={(e) => change({ active: e.target.checked })}
          />
        </Field>
        <h3>Предпросмотр карточки</h3>
        <article className="roulette-prize">
          {value.image_url && (
            <img
              src={value.image_url}
              alt={value.image_alt || value.title || "Приз"}
            />
          )}
          <h3>{value.title || "Название приза"}</h3>
          <p>{value.summary || "Краткое описание"}</p>
          <p className="small-note">{value.terms || "Условия приза"}</p>
        </article>
        <FormMessage error={error} />
        <button
          type="button"
          className="button"
          disabled={busy || uploading}
          onClick={onSave}
        >
          Сохранить
        </button>
      </div>
    </Dialog>
  );
}
