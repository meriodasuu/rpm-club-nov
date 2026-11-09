import { handle, json, HttpError } from "@/lib/http";
import { query } from "@/lib/db";
import { authRoute } from "@/lib/auth/routes";
import { clientRoute } from "@/lib/api/client";
import { adminRoute } from "@/lib/api/admin";
import { clubRoute } from "@/lib/api/club";
import { operationsRoute } from "@/lib/api/operations";
import { notificationsRoute } from "@/lib/notifications/api";
import { after } from "next/server";
import { processJobs } from "@/lib/jobs";
import { rouletteRoute } from "@/lib/roulette";
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
async function route(request: Request, context: Context) {
  return handle(async () => {
    const path = (await context.params).path.join("/");
    if (path === "health" && request.method === "GET")
      return json({ status: "ok", service: "rpm-club" });
    if (path === "ready" && request.method === "GET") {
      await query("SELECT 1");
      return json({ status: "ready" });
    }
    for (const handler of [
      authRoute,
      notificationsRoute,
      clubRoute,
      rouletteRoute,
      clientRoute,
      operationsRoute,
      adminRoute,
    ]) {
      const response = await handler(request, path);
      if (response) {
        if (
          process.env.VERCEL === "1" &&
          request.method !== "GET" &&
          response.ok
        ) {
          after(async () => {
            try {
              await processJobs({ maintenance: false, timeBudgetMs: 15000 });
            } catch {
              console.error(
                "Post-response worker failed; queued jobs remain available for retry",
              );
            }
          });
        }
        return response;
      }
    }
    throw new HttpError(404, "NOT_FOUND", "Страница не найдена");
  });
}
export { route as GET, route as POST, route as PATCH, route as DELETE };
