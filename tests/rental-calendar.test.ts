import { describe, expect, it } from "vitest";
import {
  calendarDays,
  shiftDate,
  shiftMonth,
  dateLabel,
} from "../src/lib/club/calendar";

describe("rental calendar date-only arithmetic", () => {
  it("aligns September 2026 to Monday-first columns and spans a selected weekend", () => {
    const days = calendarDays("2026-09-25");
    expect(days).toHaveLength(35);
    expect(days[0]).toBeNull();
    expect(days[1]).toBe("2026-09-01");
    expect(days[25]).toBe("2026-09-25");
    expect(shiftDate("2026-09-25", 2)).toBe("2026-09-27");
  });
  it("handles leap days, six-week months and year boundaries", () => {
    expect(calendarDays("2028-02-01")).toContain("2028-02-29");
    expect(calendarDays("2027-02-01")).not.toContain("2027-02-29");
    expect(calendarDays("2026-03-01")).toHaveLength(42);
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftMonth("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftMonth("2027-01-01", -1)).toBe("2026-12-01");
  });
  it("formats dates and calculates limits without local timezone or DST shifts", () => {
    expect(shiftDate("2026-10-24", 2)).toBe("2026-10-26");
    expect(shiftDate("2026-09-25", 90)).toBe("2026-12-24");
    expect(
      dateLabel("2026-09-25", {
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    ).toContain("25 сентября 2026");
  });
});
