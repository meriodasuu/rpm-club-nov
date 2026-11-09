import { notFound, redirect } from "next/navigation";
import { AdminApp } from "@/components/admin/pages";
export default async function Page({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (section === "requests") redirect("/admin/rentals");
  if (
    ![
      "dashboard",
      "customers",
      "rentals",
      "transactions",
      "import",
      "offers",
      "roulette",
      "giveaways",
      "settings",
      "tiers",
      "referrals",
      "audit",
      "deliveries",
      "team",
      "fleet",
      "routes",
      "wiki",
      "requests",
      "triggers",
    ].includes(section)
  )
    notFound();
  return <AdminApp section={section} />;
}
