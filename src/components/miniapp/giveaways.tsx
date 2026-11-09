"use client";
import { Failure, Loading, useResource } from "@/components/shared";

type Giveaway = { id:string; title:string; description:string; rules:string; image_url:string; image_alt:string; minimum_tier:string; minimum_amount_kopecks:string; winner_count:number; starts_at:string; ends_at:string; status:string; qualified_amount_kopecks:string; participant:boolean; prizes:{position:number;prize:{title:string;summary:string};ttlDays:number}[]; winners:{position:number;name:string;status:string}[] };

export function GiveawaysScreen() {
  const state = useResource<{items:Giveaway[]}>("giveaways");
  if (state.loading) return <Loading />;
  if (!state.data) return <Failure error={state.error ?? new Error("Не удалось загрузить розыгрыши")} retry={state.refresh}/>;
  return <section className="roulette-catalog"><header className="roulette-heading"><span>RPM CLUB / РОЗЫГРЫШИ</span><h1>Розыгрыши<br/><em>клуба</em></h1><p>Выполняйте условия аренды — участие добавится автоматически.</p></header>
    {state.data.items.length ? state.data.items.map(g => { const target=Number(g.minimum_amount_kopecks)/100, current=Number(g.qualified_amount_kopecks)/100; return <article key={g.id} className="roulette-prize">
      {g.image_url && <div className="roulette-prize-image"><img src={g.image_url} alt={g.image_alt || g.title}/></div>}<div><h3>{g.title}</h3><p>{g.description}</p><p>Уровень: <strong>{g.minimum_tier}</strong> · победителей: {g.winner_count}</p><p>Прогресс: <strong>{current.toLocaleString("ru-RU")} / {target.toLocaleString("ru-RU")} ₽</strong></p><p>{g.participant ? "Вы участвуете" : "Условия ещё не выполнены"}</p><details><summary>Условия и сроки</summary><p>{g.rules}</p><p>До {new Date(g.ends_at).toLocaleString("ru-RU",{timeZone:"Europe/Moscow"})} МСК</p></details>
      <details><summary>Призы</summary>{g.prizes.map(prize=><p key={prize.position}>{prize.position}. {prize.prize.title} · действует {prize.ttlDays} дн.</p>)}</details>{!!g.winners.length && <details><summary>Победители</summary>{g.winners.map(w=><p key={w.position}>{w.position}. {w.name}{w.status === "issued" ? " — приз выдан" : ""}</p>)}</details>}</div>
    </article>}) : <p>Активных розыгрышей пока нет.</p>}</section>;
}
