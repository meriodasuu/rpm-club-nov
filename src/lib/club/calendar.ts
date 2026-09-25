// Date-only arithmetic stays in UTC; "today" is supplied in Moscow time.
export function shiftDate(value: string, days: number) {
  const date = new Date(value + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function shiftMonth(value: string, months: number) {
  const date = new Date(value.slice(0, 7) + "-01T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

export function calendarDays(month: string): (string | null)[] {
  const first = month.slice(0, 7) + "-01";
  const offset = (new Date(first + "T00:00:00Z").getUTCDay() + 6) % 7;
  const count = new Date(shiftMonth(first, 1) + "T00:00:00Z");
  count.setUTCDate(0);
  const cells: (string | null)[] = Array.from({ length: offset }, () => null);
  for (let day = 0; day < count.getUTCDate(); day++)
    cells.push(shiftDate(first, day));
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function dateLabel(value: string, options: Intl.DateTimeFormatOptions) {
  return new Date(value + "T00:00:00Z").toLocaleDateString("ru-RU", {
    ...options,
    timeZone: "UTC",
  });
}
