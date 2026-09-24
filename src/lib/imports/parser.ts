import Papa from "papaparse";
import ExcelJS from "exceljs";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { normalizePhone } from "@/lib/auth/telegram";
import { parseRubles } from "@/lib/loyalty";
import { HttpError } from "@/lib/http";

export type ImportProfile = {
  legacyCompletedPaid?: boolean;
  delimiter?: "," | ";";
};
export function parseCsv(
  text: string,
  delimiter: "," | ";" = ",",
): Record<string, unknown>[] {
  const result = Papa.parse<Record<string, unknown>>(
    text.replace(/^\uFEFF/, ""),
    {
      header: true,
      skipEmptyLines: "greedy",
      // Stop before a compact CSV can allocate millions of row objects on the
      // application server. One extra row lets us reject an oversized import.
      preview: 10001,
      delimiter,
      transformHeader: (h) => h.trim(),
    },
  );
  if (result.data.length > 10000)
    throw new HttpError(422, "ROW_LIMIT", "Максимум 10 000 строк");
  // PapaParse silently renames duplicate headers; money/identity columns must
  // remain unambiguous, just as in the XLSX reader below.
  if (Object.keys(result.meta.renamedHeaders ?? {}).length)
    throw new HttpError(
      422,
      "DUPLICATE_HEADERS",
      "Повторяющиеся заголовки столбцов",
    );
  if (result.errors.length)
    throw new HttpError(
      422,
      "CSV_INVALID",
      "Некорректный CSV: " + result.errors[0].message,
    );
  return result.data;
}
const rowSchema = z.object({
  externalRentalId: z.string().trim().min(1).max(128),
  phone: z.string(),
  customerName: z.string().trim().min(1).max(200),
  crmCustomerId: z.string().max(128).nullable(),
  carName: z.string().trim().min(1).max(200),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  amountKopecks: z.string().regex(/^[1-9]\d*$/),
  status: z.enum(["accepted", "completed", "in_progress", "cancelled"]),
  paymentStatus: z.enum(["paid", "unpaid", "partial", "refunded"]),
  qualifiedAt: z.iso.datetime().optional(),
});
export type NormalizedRental = z.infer<typeof rowSchema>;
export function normalizeRentalRow(
  raw: Record<string, unknown>,
  profile: ImportProfile = {},
): NormalizedRental {
  const str = (key: string) =>
    raw[key] === undefined || raw[key] === null ? "" : String(raw[key]).trim();
  const ids = ["external_id", "external_rental_id", "rental_id"]
    .map(str)
    .filter(Boolean);
  if (new Set(ids).size > 1) throw new Error("Внешние ID не совпадают");
  const amountText = (str("rental_amount") || str("amount"))
    .replace(/\s/g, "")
    .replace(",", ".");
  if (
    str("rental_amount") &&
    str("amount") &&
    parseRubles(str("rental_amount")) !== parseRubles(str("amount"))
  )
    throw new Error("Суммы аренды не совпадают");
  const row = rowSchema.parse({
    externalRentalId: ids[0] ?? "",
    phone: normalizePhone(str("phone")),
    customerName: str("customer_name"),
    crmCustomerId: str("crm_customer_id") || null,
    carName: str("car_name"),
    startDate: str("start_date"),
    endDate: str("end_date"),
    amountKopecks: parseRubles(amountText),
    status: str("status"),
    paymentStatus:
      str("payment_status") ||
      (profile.legacyCompletedPaid && str("status") === "completed"
        ? "paid"
        : ""),
    qualifiedAt: str("qualified_at") || undefined,
  });
  if (row.startDate > row.endDate)
    throw new Error("Дата окончания раньше начала");
  return row;
}
// Validate both declared and actual expansion before ExcelJS allocates workbook objects.
export function checkZipBudget(buffer: Buffer) {
  const invalid = () =>
    new HttpError(
      422,
      "XLSX_UNSAFE",
      "Некорректный XLSX, недопустимое вложение или превышение объёма данных",
    );
  try {
    let end = -1;
    for (
      let i = buffer.length - 22;
      i >= Math.max(0, buffer.length - 65557);
      i--
    )
      if (
        buffer.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
      ) {
        end = i;
        break;
      }
    if (
      end < 0 ||
      buffer.readUInt16LE(end + 4) !== 0 ||
      buffer.readUInt16LE(end + 6) !== 0
    )
      throw invalid();
    const count = buffer.readUInt16LE(end + 10),
      centralSize = buffer.readUInt32LE(end + 12),
      centralStart = buffer.readUInt32LE(end + 16);
    if (
      count < 1 ||
      count > 2000 ||
      centralStart + centralSize !== end ||
      buffer.readUInt16LE(end + 8) !== count
    )
      throw invalid();
    let index = centralStart,
      expanded = 0;
    const names = new Set<string>();
    for (let n = 0; n < count; n++) {
      if (index + 46 > end || buffer.readUInt32LE(index) !== 0x02014b50)
        throw invalid();
      const flags = buffer.readUInt16LE(index + 8),
        method = buffer.readUInt16LE(index + 10),
        compressed = buffer.readUInt32LE(index + 20),
        size = buffer.readUInt32LE(index + 24),
        nameLength = buffer.readUInt16LE(index + 28),
        extra = buffer.readUInt16LE(index + 30),
        comment = buffer.readUInt16LE(index + 32),
        local = buffer.readUInt32LE(index + 42);
      const name = buffer
        .subarray(index + 46, index + 46 + nameLength)
        .toString("utf8");
      expanded += size;
      if (
        flags & 1 ||
        ![0, 8].includes(method) ||
        size === 0xffffffff ||
        expanded > 50 * 1024 * 1024 ||
        index + 46 + nameLength + extra + comment > end ||
        names.has(name) ||
        /(^\/|\.\.|vbaProject|externalLinks|\.bin$)/i.test(name) ||
        local + 30 > centralStart ||
        buffer.readUInt32LE(local) !== 0x04034b50
      )
        throw invalid();
      names.add(name);
      const start =
        local +
        30 +
        buffer.readUInt16LE(local + 26) +
        buffer.readUInt16LE(local + 28);
      if (start + compressed > centralStart) throw invalid();
      const data = buffer.subarray(start, start + compressed);
      const actual =
        method === 0
          ? data
          : inflateRawSync(data, {
              maxOutputLength: Math.max(
                1,
                Math.min(size + 1, 50 * 1024 * 1024),
              ),
            });
      if (actual.length !== size) throw invalid();
      index += 46 + nameLength + extra + comment;
    }
    if (index !== end) throw invalid();
  } catch {
    throw invalid();
  }
}
export async function parseFile(
  buffer: Buffer,
  filename: string,
  profile: ImportProfile,
): Promise<Record<string, unknown>[]> {
  if (buffer.length > 10 * 1024 * 1024)
    throw new HttpError(
      413,
      "FILE_TOO_LARGE",
      "Максимальный размер файла — 10 МБ",
    );
  if (/\.csv$/i.test(filename)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new HttpError(
        422,
        "CSV_ENCODING",
        "Сохраните CSV в кодировке UTF-8",
      );
    }
    return parseCsv(text, profile.delimiter ?? ",");
  }
  if (!/\.xlsx$/i.test(filename))
    throw new HttpError(422, "FILE_TYPE", "Выберите CSV или XLSX");
  checkZipBudget(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  if (workbook.worksheets.length !== 1)
    throw new HttpError(
      422,
      "SHEET_COUNT",
      "Файл должен содержать один лист с арендами",
    );
  const sheet = workbook.worksheets[0];
  if (sheet.rowCount > 10001)
    throw new HttpError(422, "ROW_LIMIT", "Максимум 10 000 строк");
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, col) => {
    headers[col] = String(cell.value ?? "").trim();
  });
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length)
    throw new HttpError(
      422,
      "DUPLICATE_HEADERS",
      "Повторяющиеся заголовки столбцов",
    );
  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const data: Record<string, unknown> = {};
    row.eachCell((cell, col) => {
      const value = cell.value;
      if (value && typeof value === "object" && !(value instanceof Date))
        throw new HttpError(
          422,
          "CELL_FORMULA",
          "Формулы, ссылки и форматированный текст в ячейках не поддерживаются",
        );
      data[headers[col]] =
        value instanceof Date ? value.toISOString().slice(0, 10) : value;
    });
    rows.push(data);
  });
  return rows;
}
