import { IdentityPage } from "@/components/admin/identity";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <IdentityPage id={(await params).id} />;
}
