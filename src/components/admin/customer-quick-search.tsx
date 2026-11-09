"use client";

import { Search, UserRound } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner, useResource } from "@/components/shared";
import type { Row } from "./tables";

export function CustomerQuickSearch({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const resultsId = useId();
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(value.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [value]);

  const result = useResource<{ items: Row[] }>(
    `admin/customers?q=${encodeURIComponent(query)}`,
  );
  const items = result.data?.items ?? [];
  const isOpen = query.length > 0;

  return (
    <div className={"customer-quick-search " + (compact ? "compact" : "")}>
      <label>
        <Search size={compact ? 16 : 18} aria-hidden="true" />
        <span className="sr-only">Быстрый поиск участника</span>
        <input
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Найти участника"
          autoComplete="off"
          aria-controls={resultsId}
          aria-expanded={isOpen}
        />
      </label>
      {isOpen && (
        <div
          className="customer-quick-results"
          id={resultsId}
          role="listbox"
          aria-label="Результаты поиска участников"
        >
          {result.loading ? (
            <p role="status"><Spinner /> Ищем участника…</p>
          ) : result.error ? (
            <p role="status">Не удалось выполнить поиск. Повторите попытку.</p>
          ) : items.length ? (
            items.slice(0, 6).map((customer) => (
              <button
                key={String(customer.id)}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => router.push(`/admin/customers/${customer.id}`)}
              >
                <UserRound size={16} aria-hidden="true" />
                <span>
                  <strong>{String(customer.name)}</strong>
                  <small>{String(customer.phone || customer.public_member_id || "Участник клуба")}</small>
                </span>
              </button>
            ))
          ) : (
            <p role="status">Участники не найдены</p>
          )}
        </div>
      )}
    </div>
  );
}
