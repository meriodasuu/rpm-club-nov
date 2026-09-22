import { query } from "@/lib/db";
export function safeMaintenanceCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  return [
    "23502",
    "23503",
    "23505",
    "23514",
    "40001",
    "40P01",
    "42P01",
    "42703",
    "42501",
    "53300",
    "57014",
    "57P01",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
  ].includes(code)
    ? code
    : "UNEXPECTED_ERROR";
}
export class MaintenanceStageError extends Error {
  constructor(
    public stage: string,
    public safeCode: string,
  ) {
    super("Не удалось завершить фоновый этап");
  }
}
export async function maintenanceStage<T>(
  stage: string,
  work: () => Promise<T>,
  startedAt: string,
): Promise<T> {
  try {
    const result = await work();
    await query(
      "UPDATE operational_errors SET resolved_at=clock_timestamp() WHERE kind='job_maintenance' AND details->>'stage'=$1 AND resolved_at IS NULL AND created_at<=$2::timestamptz",
      [stage, startedAt],
    );
    return result;
  } catch (error) {
    throw new MaintenanceStageError(stage, safeMaintenanceCode(error));
  }
}
