import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/session";
import { query } from "@/lib/db";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
  const { memberId } = await params;
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(memberId)) notFound();
  try {
    await requireStaff(
      new Request(
        (process.env.APP_URL ?? "http://127.0.0.1:3000") + "/m/" + memberId,
        { headers: await headers() },
      ),
    );
  } catch {
    redirect("/admin/login?next=" + encodeURIComponent("/m/" + memberId));
  }
  const [user] = await query<{ id: string }>(
    "SELECT id FROM users WHERE public_member_id=$1",
    [memberId],
  );
  if (!user) notFound();
  redirect("/admin/customers/" + user.id);
}
