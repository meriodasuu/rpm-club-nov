import { notFound } from "next/navigation";
import { localPreviewEnabled } from "@/lib/auth/session";
import { Preview } from "@/components/preview";
export const dynamic = "force-dynamic";
export default function Page() {
  if (!localPreviewEnabled()) notFound();
  return <Preview />;
}
