"use client";

import { Crown, Medal } from "lucide-react";
import { Failure, Loading, useResource } from "@/components/shared";
import { money } from "@/lib/ui";

type LeaderboardEntry = {
  rank: number;
  nickname: string;
  total_rental_amount: string;
  isCurrentUser: boolean;
};

export function LeaderboardScreen() {
  const { data, error, loading, refresh } = useResource<{
    items: LeaderboardEntry[];
    currentUser: LeaderboardEntry | null;
  }>("leaderboard", 30_000);

  if (loading) return <Loading />;
  if (error || !data)
    return <Failure error={error ?? new Error("Нет данных рейтинга")} retry={refresh} />;

  return (
    <section className="leaderboard" aria-label="Рейтинг клуба">
      <div className="leaderboard-hero">
        <Crown size={25} aria-hidden="true" />
        <div>
          <h1>Рейтинг клуба</h1>
          <p>По сумме завершённых и оплаченных аренд</p>
        </div>
      </div>
      {!data.items.length ? (
        <p className="small-note">Рейтинг появится после первых завершённых аренд.</p>
      ) : (
        <ol className="leaderboard-list">
          {data.items.map((member) => (
            <li className={member.isCurrentUser ? "current" : ""} key={member.rank}>
              <span className="leaderboard-place">
                {member.rank <= 3 ? <Medal size={18} aria-label={`${member.rank} место`} /> : member.rank}
              </span>
              <strong>{member.nickname}</strong>
              <span>{money(member.total_rental_amount)}</span>
            </li>
          ))}
        </ol>
      )}
      {data.currentUser && !data.currentUser.isCurrentUser && (
        <div className="leaderboard-me">
          <span>Ваше место: {data.currentUser.rank}</span>
          <strong>{money(data.currentUser.total_rental_amount)}</strong>
        </div>
      )}
    </section>
  );
}
