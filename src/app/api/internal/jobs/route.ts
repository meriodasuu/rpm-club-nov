import { secretMatches } from "@/lib/auth/session";
import { handle, HttpError, json } from "@/lib/http";
import { processJobs } from "@/lib/jobs";
export const runtime = "nodejs";
export const maxDuration = 60;
async function run(request: Request) {
  return handle(async () => {
    if (
      (process.env.CRON_SECRET?.length ?? 0) < 32 ||
      !secretMatches(
        request.headers.get("authorization"),
        process.env.CRON_SECRET
          ? `Bearer ${process.env.CRON_SECRET}`
          : undefined,
      )
    )
      throw new HttpError(401, "CRON_AUTH", "Доступ запрещён");
    return json(await processJobs());
  });
}
export { run as GET, run as POST };
