import { redirect } from "next/navigation";
import { localPreviewEnabled } from "@/lib/auth/session";
export default function Page() {
  redirect(localPreviewEnabled() ? "/preview" : "/onboarding");
}
