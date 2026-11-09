import { randomUUID } from "node:crypto";
import { transaction } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { drawWinners } from "./draw";

type Tx = { query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]> };
type Giveaway = { id:string; minimum_tier:string; minimum_amount_kopecks:string; starts_at:Date; ends_at:Date; winner_count:number; title:string; status:string };

export async function syncGiveawayParticipants(tx: Tx, giveaway: Giveaway, cutoff: Date) {
  await tx.query("DELETE FROM giveaway_participants WHERE giveaway_id=$1", [giveaway.id]);
  await tx.query(
    `WITH latest AS (SELECT DISTINCT ON (e.rental_id) e.* FROM giveaway_rental_events e WHERE e.changed_at<$4 ORDER BY e.rental_id,e.changed_at DESC,e.id DESC),
    qualified AS (SELECT e.rental_id,e.user_id,e.current_amount_kopecks FROM latest e WHERE e.status='completed' AND e.payment_status='paid' AND e.current_amount_kopecks>0 AND e.created_at>=$2 AND e.created_at<$3 AND e.completed_at>=$2 AND e.completed_at<$3 AND e.paid_at>=$2 AND e.paid_at<$3 AND e.trust_metadata->>'completion'<>'untrusted' AND e.trust_metadata->>'payment'<>'untrusted'),
    eligible_tier AS (SELECT a.user_id FROM loyalty_accounts a JOIN loyalty_tiers current_tier ON current_tier.code=a.achieved_tier JOIN loyalty_tiers required_tier ON required_tier.code=$5 WHERE current_tier.rank>=required_tier.rank UNION SELECT te.user_id FROM tier_events te JOIN loyalty_tiers reached ON reached.code=te.to_tier JOIN loyalty_tiers required_tier ON required_tier.code=$5 WHERE te.created_at<$4 AND reached.rank>=required_tier.rank)
    INSERT INTO giveaway_participants(giveaway_id,user_id,qualified_amount_kopecks,qualifying_rental_ids,qualified_at)
    SELECT $1,q.user_id,sum(q.current_amount_kopecks),array_agg(q.rental_id ORDER BY q.rental_id),clock_timestamp() FROM qualified q JOIN eligible_tier t ON t.user_id=q.user_id GROUP BY q.user_id HAVING sum(q.current_amount_kopecks)>=$6`,
    [giveaway.id,giveaway.starts_at,giveaway.ends_at,cutoff,giveaway.minimum_tier,giveaway.minimum_amount_kopecks],
  );
}

export async function refreshGiveawayParticipants(limit = 50) {
  return transaction(async (tx: Tx) => {
    const giveaways = await tx.query<Giveaway>("SELECT id,minimum_tier,minimum_amount_kopecks,starts_at,ends_at,winner_count,title,status FROM giveaways WHERE status='published' AND starts_at<=clock_timestamp() AND ends_at>clock_timestamp() ORDER BY ends_at,id LIMIT $1 FOR UPDATE SKIP LOCKED",[limit]);
    for (const giveaway of giveaways) await syncGiveawayParticipants(tx,giveaway,new Date());
    return giveaways.length;
  });
}

async function issueWinnerAward(tx: Tx, winner: { id:string; giveaway_id:string; user_id:string; prize_snapshot:unknown }, ttlDays: number) {
  const [existing] = await tx.query<{ id:string }>("SELECT id FROM roulette_awards WHERE giveaway_winner_id=$1",[winner.id]);
  if (existing) return existing.id;
  const [award] = await tx.query<{ id:string }>("INSERT INTO roulette_awards(spin_id,giveaway_winner_id,user_id,prize_snapshot,expires_at) VALUES(NULL,$1,$2,$3,clock_timestamp()+$4*interval '1 day') RETURNING id",[winner.id,winner.user_id,JSON.stringify(winner.prize_snapshot),ttlDays]);
  await tx.query("UPDATE giveaway_winners SET award_id=$2,status='issued',issued_at=clock_timestamp(),issued_by='giveaway-worker' WHERE id=$1",[winner.id,award.id]);
  await tx.query("INSERT INTO outbox_events(event_key,event_type,user_id,aggregate_id,payload) VALUES($1,'GIVEAWAY_WON',$2,$3,$4) ON CONFLICT(event_key) DO NOTHING",[`giveaway-winner:${winner.id}`,winner.user_id,winner.id,JSON.stringify({giveawayId:winner.giveaway_id,awardId:award.id,title:(winner.prize_snapshot as {title?:string}).title ?? "Приз"})]);
  return award.id;
}

async function drawOne(tx: Tx,id: string,actorId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('giveaway-rental-evidence',0))");
  const [giveaway] = await tx.query<Giveaway>("SELECT id,minimum_tier,minimum_amount_kopecks,starts_at,ends_at,winner_count,title,status FROM giveaways WHERE id=$1 FOR UPDATE",[id]);
  if (!giveaway) throw new HttpError(404,"GIVEAWAY_NOT_FOUND","Розыгрыш не найден");
  if (giveaway.status==='drawn') return {alreadyDrawn:true,participantCount:0,winnerIds:[] as string[]};
  if (giveaway.status!=='published' || new Date(giveaway.ends_at)>new Date()) throw new HttpError(409,"GIVEAWAY_NOT_READY","Розыгрыш ещё не завершён или отменён");
  await syncGiveawayParticipants(tx,giveaway,new Date(giveaway.ends_at));
  const entries=await tx.query<{user_id:string;qualified_amount_kopecks:string;qualifying_rental_ids:string[]}>("SELECT user_id,qualified_amount_kopecks::text,qualifying_rental_ids FROM giveaway_participants WHERE giveaway_id=$1 ORDER BY user_id FOR UPDATE",[id]);
  const snapshot=entries.map(entry=>({...entry}));
  await tx.query("INSERT INTO giveaway_draws(giveaway_id,participant_snapshot) VALUES($1,$2) ON CONFLICT(giveaway_id) DO NOTHING",[id,JSON.stringify(snapshot)]);
  const prizes=await tx.query<{position:number;prize_snapshot:unknown;ttl_days:number}>("SELECT position,prize_snapshot,ttl_days FROM giveaway_prizes WHERE giveaway_id=$1 ORDER BY position",[id]);
  if (prizes.length!==giveaway.winner_count) throw new HttpError(409,"GIVEAWAY_PRIZES","Для каждого места должен быть настроен отдельный приз");
  const ids=drawWinners(snapshot.map(entry=>entry.user_id),giveaway.winner_count);
  for(let index=0;index<ids.length;index++) {
    const [winner]=await tx.query<{id:string;giveaway_id:string;user_id:string;prize_snapshot:unknown}>("INSERT INTO giveaway_winners(giveaway_id,position,user_id,prize_snapshot) VALUES($1,$2,$3,$4) RETURNING id,giveaway_id,user_id,prize_snapshot",[id,index+1,ids[index],JSON.stringify(prizes[index].prize_snapshot)]);
    await issueWinnerAward(tx,winner,prizes[index].ttl_days);
  }
  await tx.query("UPDATE giveaway_draws SET completed_at=clock_timestamp() WHERE giveaway_id=$1",[id]);
  await tx.query("UPDATE giveaways SET status='drawn',drawn_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[id]);
  await tx.query("INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES($1,'system','giveaway.draw','giveaway',$2,'Случайный выбор и автоматическая выдача призов',$3)",[actorId,id,JSON.stringify({participantCount:snapshot.length,winnerCount:ids.length,runId:randomUUID()})]);
  return {alreadyDrawn:false,participantCount:snapshot.length,winnerIds:ids};
}

export async function conductGiveaway(id:string,actorId:string) { return transaction(tx=>drawOne(tx,id,actorId)); }
export async function drawDueGiveaways(limit=20) {
  const ids=await transaction(tx=>tx.query<{id:string}>("SELECT id FROM giveaways WHERE status='published' AND ends_at<=clock_timestamp() ORDER BY ends_at,id LIMIT $1 FOR UPDATE SKIP LOCKED",[limit]));
  let completed=0;
  for(const {id} of ids) try { if (!(await conductGiveaway(id,"giveaway-worker")).alreadyDrawn) completed++; } catch(error) { await transaction(tx=>tx.query("INSERT INTO operational_errors(kind,entity_id,details) VALUES('giveaway_draw',$1,$2)",[id,JSON.stringify({message:error instanceof Error?error.message:"Unknown error"})])); }
  return completed;
}
