import { describe, it, expect } from "vitest";
import {
  normalizeRentalRow,
  parseCsv,
  parseFile,
} from "../src/lib/imports/parser";
import ExcelJS from "exceljs";
const sample = {
  external_rental_id: "rent_1",
  phone: "+79991234567",
  customer_name: "Роман",
  car_name: "Porsche",
  start_date: "2026-08-20",
  end_date: "2026-08-21",
  rental_amount: "35000.50",
  status: "completed",
  payment_status: "paid",
};
describe("Import boundary", () => {
  it("converts exact money and phone", () =>
    expect(normalizeRentalRow(sample).amountKopecks).toBe("3500050"));
  it("requires payment proof", () =>
    expect(() =>
      normalizeRentalRow({ ...sample, payment_status: undefined }),
    ).toThrow());
  it("allows deliberate legacy paid profile", () =>
    expect(
      normalizeRentalRow(
        { ...sample, payment_status: undefined },
        { legacyCompletedPaid: true },
      ).paymentStatus,
    ).toBe("paid"));
  it("rejects date ambiguity, formulas and conflicting IDs", () => {
    expect(() =>
      normalizeRentalRow({ ...sample, start_date: "20/08/26" }),
    ).toThrow();
    expect(() =>
      normalizeRentalRow({ ...sample, rental_amount: "=100+2" }),
    ).toThrow();
    expect(() =>
      normalizeRentalRow({ ...sample, external_id: "other" }),
    ).toThrow();
  });
  it("parses quoted CSV without splitting names", () =>
    expect(
      parseCsv('external_rental_id,customer_name\nr1,"Роман, клиент"', ",")[0]
        .customer_name,
    ).toBe("Роман, клиент"));
  it("rejects compact CSV files exceeding the row budget during parsing", () => {
    expect(() => parseCsv("rental_id\n" + "r1\n".repeat(10001))).toThrow(
      "Максимум 10 000 строк",
    );
    expect(parseCsv("rental_id\n" + "r1\n".repeat(10000))).toHaveLength(10000);
  });
  it("returns a validation error for unsupported CSV encoding", async () => {
    await expect(
      parseFile(Buffer.from([0xff, 0xfe, 0x41]), "rentals.csv", {}),
    ).rejects.toMatchObject({ status: 422, code: "CSV_ENCODING" });
  });
  it.each(["rental_amount,rental_amount", " rental_amount ,rental_amount"])(
    "rejects ambiguous CSV money headers: %s",
    (headers) => {
      expect(() => parseCsv(headers + "\n100,100000")).toThrow(
        "Повторяющиеся заголовки",
      );
    },
  );
  it("rejects XLSX duplicate headers after whitespace normalization", async () => {
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet("Rentals");
    sheet.addRow([" rental_amount ", "rental_amount"]);
    sheet.addRow([100, 100000]);
    await expect(
      parseFile(
        Buffer.from(await workbook.xlsx.writeBuffer()),
        "duplicate.xlsx",
        {},
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_HEADERS" });
  });
});
