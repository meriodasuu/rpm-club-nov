import Link from "next/link";
import { notFound } from "next/navigation";
import { query } from "@/lib/db";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const { type } = await params,
    { version } = await searchParams;
  if (!["rules", "privacy", "personal-data"].includes(type)) notFound();
  const [doc] = await query<{ title: string; body: string; version: string }>(
    "SELECT title,body,version FROM legal_documents WHERE type=$1 AND ($2::text IS NULL OR version=$2) AND published_at<=now() ORDER BY published_at DESC LIMIT 1",
    [type, version ?? null],
  );
  if (!doc) notFound();
  return (
    <main className="legal-page">
      <Link href="/profile" className="text-link">
        ← RPM Club
      </Link>
      <span className="eyebrow">РЕДАКЦИЯ {doc.version}</span>
      <h1>{doc.title}</h1>
      <div className="legal-text">{doc.body}</div>
    </main>
  );
}
