"use client";

import { useState } from "react";
import { Dialog } from "@/components/shared";

const prizes = [
  {
    id: "discount",
    title: "Скидка 10% на аренду",
    code: "RM-N45E57LUNA",
    benefit: "−10%",
    terms: "Подробные условия применения скидки, срок действия и доступность автомобилей уточняйте у менеджера RPM Rent.",
  },
  {
    id: "upgrade",
    title: "Повышение класса автомобиля",
    code: "RM-8H3K2P",
    benefit: "Улучшение",
    terms: "Предложение действует при наличии свободного автомобиля более высокого класса.",
  },
];

export default function PrizePreviewPage() {
  const [selected, setSelected] = useState<string[]>(["discount"]);

  return (
    <Dialog title="Оформление аренды" onClose={() => {}} fullScreen>
      <form className="rental-booking-form">
        <div className="rental-car-summary">
          <div className="rental-car-placeholder" />
          <div>
            <span className="car-brand">Porsche</span>
            <h3>911 Carrera</h3>
            <p>45 000 ₽ / сутки</p>
          </div>
        </div>
        <div className="rental-date-fields">
          <button type="button">Начало аренды<br /><strong>19 октября</strong></button>
          <button type="button">Возврат<br /><strong>20 октября</strong></button>
        </div>
        <p className="rental-calendar-note">Время получения согласует менеджер</p>
        <section className="rental-prize-picker" aria-label="Призы для этой аренды">
          <div className="rental-prize-heading">
            <span className="rental-prize-icon" aria-hidden="true">✦</span>
            <div><h3>Призы</h3><p>Выберите, что применить к аренде</p></div>
            <span className="rental-prize-count">2</span>
          </div>
          <div className="rental-prize-list">
            {prizes.map((prize) => {
              const checked = selected.includes(prize.id);
              return (
                <article className={`rental-prize-option${checked ? " selected" : ""}`} key={prize.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => setSelected((current) => event.target.checked ? [...current, prize.id] : current.filter((id) => id !== prize.id))}
                    />
                    <span className="rental-prize-copy">
                      <span className="rental-prize-title">{prize.title}</span>
                      <span className="rental-prize-code">Код <code>{prize.code}</code></span>
                    </span>
                    <span className="rental-prize-benefit">{prize.benefit}</span>
                  </label>
                  <details className="rental-prize-terms"><summary>Условия приза</summary><p>{prize.terms}</p></details>
                </article>
              );
            })}
          </div>
          <p className="rental-prize-note">Выбранные призы будут видны менеджеру в заявке.</p>
        </section>
        <div className="rental-total">
          <div><span>45 000 ₽ × 1 сут.</span><span>45 000 ₽</span></div>
          <div className="rental-discount"><span>Скидка по карте 3%</span><span>−1 350 ₽</span></div>
          <div className="rental-discount"><span>Приз: Скидка 10%</span><span>−4 365 ₽</span></div>
          <div className="rental-total-amount"><strong>Итого</strong><strong>39 285 ₽</strong></div>
        </div>
        <div className="rental-comment"><button className="rental-comment-toggle" type="button">＋　Добавить комментарий</button></div>
        <div className="rental-submit"><button className="button button-full" type="button">Отправить заявку</button></div>
      </form>
    </Dialog>
  );
}
