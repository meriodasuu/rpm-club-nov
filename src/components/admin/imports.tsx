"use client";
import { useState } from "react";
import { Upload, Download, Check, FileSpreadsheet } from "lucide-react";
import {
  api,
  command,
  useResource,
  Field,
  FormMessage,
  Spinner,
  Failure,
} from "@/components/shared";
import { DataTable, PageHeading, type Row } from "./tables";
import type { StaffView } from "./shell";
import { date } from "@/lib/ui";
type Batch = {
  batch: Row;
  stats: { status: string; count: number }[];
  rows: Row[];
};
const states: Record<string, string> = {
  valid: "Готова",
  invalid: "Ошибка проверки",
  error: "Ошибка",
  processed: "Применена",
  duplicate: "Дубликат",
  validated: "Проверен",
  queued: "В очереди",
  processing: "Обрабатывается",
  completed: "Завершён",
  completed_with_errors: "Завершён с ошибками",
};
export function ImportPage({ staff }: { staff: StaffView }) {
  const [file, setFile] = useState<File | null>(null),
    [mode, setMode] = useState("operational"),
    [delimiter, setDelimiter] = useState(";"),
    [legacy, setLegacy] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<Batch | null>(null);
  const history = useResource<{ items: Row[] }>("admin/imports", 10000);
  async function preview() {
    if (!file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("mode", mode);
      form.set("delimiter", delimiter);
      form.set("legacyCompletedPaid", String(legacy));
      setResult(
        await api<Batch>("admin/imports", { method: "POST", body: form }),
      );
      void history.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!result) return;
    setBusy(true);
    setError("");
    try {
      setResult(
        await command<Batch>(`admin/imports/${result.batch.id}/commit`, {}),
      );
      void history.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    setBusy(true);
    try {
      setResult(await api<Batch>("admin/imports/" + id));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Импорт аренд"
        subtitle="Проверьте строки перед применением к программе"
      >
        <a
          className="button button-outline"
          href="/templates/rentals.csv"
          download
        >
          <Download size={17} />
          Шаблон CSV
        </a>
      </PageHeading>
      {staff.role !== "viewer" && (
        <section className="panel">
          <div className="panel-body">
            <div className="form-grid">
              <Field label="Режим">
                <select
                  value={mode}
                  disabled={busy}
                  onChange={(e) => {
                    setMode(e.target.value);
                    setResult(null);
                  }}
                >
                  <option value="operational">
                    Текущие аренды · сумма и Bonus
                  </option>
                  {staff.role === "admin" && (
                    <option value="historical">
                      История · только сумма и уровень
                    </option>
                  )}
                </select>
              </Field>
              <Field label="Разделитель CSV">
                <select
                  value={delimiter}
                  disabled={busy}
                  onChange={(e) => {
                    setDelimiter(e.target.value);
                    setResult(null);
                  }}
                >
                  <option value=";">Точка с запятой ;</option>
                  <option value=",">Запятая ,</option>
                </select>
              </Field>
            </div>
            <label className="upload-zone">
              <FileSpreadsheet size={32} />
              <strong>{file?.name ?? "Выберите CSV или XLSX"}</strong>
              <span>До 10 МБ · 10 000 строк · один лист</span>
              <input
                type="file"
                accept=".csv,.xlsx"
                disabled={busy}
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setResult(null);
                }}
              />
            </label>
            {staff.role === "admin" && (
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={legacy}
                  disabled={busy}
                  onChange={(e) => {
                    setLegacy(e.target.checked);
                    setResult(null);
                  }}
                />
                В старом файле нет оплаты: считать завершённые аренды
                оплаченными
              </label>
            )}
            <p className="small-note">
              Обязательные поля: rental_id, customer_name, phone, car_name,
              start_date, end_date, amount, status, payment_status. Сумма — в
              рублях. Проверка файла не начисляет Bonus.
            </p>
            <button
              className="button"
              disabled={!file || busy}
              onClick={() => void preview()}
            >
              {busy ? <Spinner /> : <Upload size={18} />}Проверить файл
            </button>
          </div>
        </section>
      )}
      <FormMessage error={error} />
      {result && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>{String(result.batch.filename)}</h2>
              <p className="small-note">
                Режим:{" "}
                {result.batch.mode === "historical"
                  ? "исторический"
                  : "текущий"}
              </p>
              <span className="small-note">
                {states[String(result.batch.status)] ??
                  String(result.batch.status)}{" "}
                ·{" "}
                {result.stats
                  .map((s) => `${states[s.status] ?? s.status}: ${s.count}`)
                  .join(" / ")}
              </span>
            </div>
            <div className="detail-actions">
              <button
                className="button button-small button-outline"
                disabled={busy}
                onClick={() => void open(String(result.batch.id))}
              >
                Обновить
              </button>
              <a
                className="button button-small button-outline"
                href={`/api/admin/imports/${result.batch.id}/errors`}
              >
                <Download size={16} />
                Ошибки
              </a>
              {result.batch.status === "validated" &&
                staff.role !== "viewer" && (
                  <button
                    className="button button-small"
                    disabled={
                      busy ||
                      !result.stats.some((s) => s.status === "valid" && s.count)
                    }
                    onClick={() => void commit()}
                  >
                    <Check size={16} />
                    Применить проверенные строки
                  </button>
                )}
            </div>
          </div>
          <DataTable
            headings={["Строка", "ID аренды", "Клиент", "Статус", "Ошибка"]}
            rows={result.rows}
            render={(r) => {
              const p = r.payload as Row;
              return (
                <>
                  <td>{String(r.row_number)}</td>
                  <td>{String(p.externalRentalId ?? p.rental_id ?? "—")}</td>
                  <td>{String(p.customerName ?? p.customer_name ?? "—")}</td>
                  <td>
                    {(r.result as Row)?.classification === "nonqualifying"
                      ? "Без начисления"
                      : (states[String(r.status)] ?? String(r.status))}
                  </td>
                  <td>{(r.errors as string[]).join("; ")}</td>
                </>
              );
            }}
          />
          <div className="table-footer">
            Показаны первые 100 строк. Остальные обрабатываются фоновым
            заданием.
          </div>
        </section>
      )}
      <section className="panel">
        <div className="panel-header">
          <h2>История загрузок</h2>
        </div>
        {history.error ? (
          <Failure error={history.error} retry={history.refresh} />
        ) : (
          <DataTable
            headings={["Файл", "Режим", "Дата", "Статус", ""]}
            rows={history.data?.items ?? []}
            render={(r) => (
              <>
                <td>{String(r.filename)}</td>
                <td>{r.mode === "historical" ? "Исторический" : "Текущий"}</td>
                <td>{date(String(r.created_at))}</td>
                <td>{states[String(r.status)] ?? String(r.status)}</td>
                <td>
                  <button
                    className="text-link"
                    disabled={busy}
                    onClick={() => void open(String(r.id))}
                  >
                    Открыть
                  </button>
                </td>
              </>
            )}
          />
        )}
      </section>
    </>
  );
}
