import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { readLimitedBody } from "../src/lib/http";
import {
  parseFile,
  checkZipBudget,
  normalizeRentalRow,
} from "../src/lib/imports/parser";
async function workbook(formula = false) {
  const w = new ExcelJS.Workbook(),
    s = w.addWorksheet("Rentals");
  s.addRow([
    "rental_id",
    "customer_name",
    "phone",
    "car_name",
    "start_date",
    "end_date",
    "amount",
    "status",
    "payment_status",
  ]);
  s.addRow([
    "synthetic-upload",
    "Test",
    "+79990000000",
    "Porsche",
    "2026-09-01",
    "2026-09-02",
    formula ? { formula: "1+1", result: 2 } : "35000.50",
    "completed",
    "paid",
  ]);
  return Buffer.from(await w.xlsx.writeBuffer());
}
describe("bounded uploads", () => {
  it("rejects a chunked body while reading, before allocating beyond the limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(20));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(readLimitedBody(request, 30)).rejects.toMatchObject({
      status: 413,
    });
    expect(cancelled).toBe(true);
  });
  it("reads real XLSX and rejects formulas", async () => {
    const rows = await parseFile(await workbook(), "safe.xlsx", {});
    expect(normalizeRentalRow(rows[0]).amountKopecks).toBe("3500050");
    await expect(
      parseFile(await workbook(true), "formula.xlsx", {}),
    ).rejects.toMatchObject({ code: "CELL_FORMULA" });
  });
  it("rejects an XLSX lying about its expanded size", async () => {
    const bytes = await workbook();
    for (let i = 0; i < bytes.length - 46; i++)
      if (
        bytes.readUInt32LE(i) === 0x02014b50 &&
        bytes.readUInt32LE(i + 24) > 0
      ) {
        bytes.writeUInt32LE(0, i + 24);
        break;
      }
    expect(() => checkZipBudget(bytes)).toThrow();
  });
});
