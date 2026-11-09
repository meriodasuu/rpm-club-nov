"use client";

import { Trophy } from "lucide-react";
import Link from "next/link";
import { Failure, Loading, useResource } from "@/components/shared";
import { money } from "@/lib/ui";

type Leaderboard = { items: { rank: number; nickname: string; totalRentalAmount: string; isCurrentUser: boolean }[] };

function LeaderboardRows({ items }: Pick<Leaderboard, "items">) {
  return <ol className="club-rating-list">{items.map((item) => <li key={`${item.rank}-${item.nickname}`} className={item.isCurrentUser ? "current" : ""}><strong className="club-rating-place">{item.rank}</strong><span className="club-rating-name">{item.nickname}</span><strong>{money(item.totalRentalAmount)}</strong></li>)}</ol>;
}

export function LeaderboardPreview() {
  const { data, error, loading, refresh } = useResource<Leaderboard>("leaderboard", 30000);
  if (loading) return <Loading />;
  if (error || !data) return <Failure error={error ?? new Error("Нет данных рейтинга")} retry={refresh} />;
  return <section className="club-rating club-rating-preview" aria-label="Рейтинг клуба">
    <div className="club-rating-heading"><Trophy size={23} aria-hidden="true" /><div><h2>Рейтинг клуба</h2><p className="screen-subtitle">Топ‑10 по сумме завершённых аренд</p></div></div>
    {data.items.length ? <LeaderboardRows items={data.items.slice(0, 10)} /> : <p className="small-note">Рейтинг появится после первых завершённых аренд.</p>}
    <Link className="button button-outline button-wide" href="/club/rating">Посмотреть топ‑50 рейтинга</Link>
  </section>;
}

export function LeaderboardScreen() {
  const { data, error, loading, refresh } = useResource<Leaderboard>("leaderboard", 30000);
  if (loading) return <Loading />;
  if (error || !data) return <Failure error={error ?? new Error("Нет данных рейтинга")} retry={refresh} />;
  return <section className="club-rating">
    <div className="club-rating-heading"><Trophy size={25} aria-hidden="true" /><div><h1>Рейтинг клуба</h1><p className="screen-subtitle">По сумме завершённых аренд</p></div></div>
    {data.items.length ? <LeaderboardRows items={data.items} /> : <p className="small-note">Рейтинг появится после первых завершённых аренд.</p>}
  </section>;
}
