"use client";

import Link from "next/link";
import { useState } from "react";
import { Phone, MapPin, Send, Copy, Check, ArrowUpRight } from "lucide-react";

// Phone and channel: rpmrent.ru/contacts. Address confirmed by the owner, 2026-09-23.
const phone = "+79939838080";
const address = "Санкт-Петербург, Пискаревский проспект, 144АК";

export function ContactsScreen() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copyPhone() {
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <>
      <h1>Контакты RPM</h1>
      <p className="screen-subtitle">
        Поможем с выбором автомобиля, заявкой и условиями аренды.
      </p>
      <section className="contact-card" aria-labelledby="contact-phone">
        <Phone size={24} aria-hidden="true" />
        <h2 id="contact-phone">Связаться с командой</h2>
        <a className="contact-phone" href={"tel:" + phone}>
          +7 993 983-80-80
        </a>
        <div className="contact-actions">
          <a className="button button-wide" href={"tel:" + phone}>
            <Phone size={18} /> Позвонить в RPM
          </a>
          <button
            className="button button-outline button-wide"
            onClick={copyPhone}
          >
            {copied ? <Check size={18} /> : <Copy size={18} />}
            {copied ? "Номер скопирован" : "Скопировать номер"}
          </button>
        </div>
        <p className="small-note" role="status" aria-live="polite">
          {copyError
            ? "Не удалось скопировать. Выделите номер и скопируйте его вручную."
            : copied
              ? "Номер телефона готов к вставке."
              : "По вопросам аренды и вашей заявки звоните по этому номеру."}
        </p>
      </section>
      <section className="contact-card" aria-labelledby="contact-address">
        <MapPin size={24} aria-hidden="true" />
        <h2 id="contact-address">Где нас найти</h2>
        <p>
          {address}
          <br />2 этаж
        </p>
        <a
          className="text-link"
          href={"https://yandex.ru/maps/?text=" + encodeURIComponent(address)}
          target="_blank"
          rel="noreferrer"
        >
          Открыть в картах <ArrowUpRight size={17} />
        </a>
      </section>
      <section className="contact-card" aria-labelledby="contact-channel">
        <Send size={24} aria-hidden="true" />
        <h2 id="contact-channel">RPM в Telegram</h2>
        <p>Новости, автомобили и предложения в нашем канале.</p>
        <a
          className="text-link"
          href="https://t.me/rpmrent"
          target="_blank"
          rel="noreferrer"
        >
          Открыть канал <ArrowUpRight size={17} />
        </a>
      </section>
      <Link href="/rent" className="button button-outline button-wide">
        Оставить заявку на аренду
      </Link>
      <p className="small-note">Оплата аренды — на месте.</p>
    </>
  );
}
