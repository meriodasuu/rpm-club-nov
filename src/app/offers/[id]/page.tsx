import { OfferDetail } from "@/components/miniapp/app";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <OfferDetail id={(await params).id} />;
}
