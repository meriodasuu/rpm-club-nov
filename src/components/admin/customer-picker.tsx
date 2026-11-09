"use client";
import { useEffect, useState } from "react";
import { Field, FormMessage, Spinner, useResource } from "@/components/shared";
import type { Row } from "./tables";

export function CarNameField() {
  const r = useResource<{ items: Row[] }>("admin/club-content?kind=car");
  const cars = r.data?.items.filter((car) => car.active === true) ?? [];
  return (
    <Field
      label="Автомобиль"
      hint="Выберите опубликованный автомобиль из автопарка"
    >
      <select name="carName" required defaultValue="">
        <option value="" disabled>
          {r.loading ? "Загружаем автопарк…" : "Выберите автомобиль"}
        </option>
        {cars.map((car) => (
          <option key={String(car.id)} value={String(car.title)}>
            {String(car.title)}
          </option>
        ))}
      </select>
      {r.error && <FormMessage error={r.error.message} />}
      {!r.loading && !r.error && !cars.length && (
        <small>В автопарке нет опубликованных автомобилей.</small>
      )}
    </Field>
  );
}

export function CustomerPicker({
  onSelect,
}: {
  onSelect?: (customer: Row | null) => void;
}) {
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<Row | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const r = useResource<{ items: Row[] }>(
    `admin/customers?q=${encodeURIComponent(query)}`,
  );
  const items = r.data?.items ?? [];
  function choose(customer: Row | null) {
    setSelected(customer);
    onSelect?.(customer);
    setSearch("");
    setQuery("");
  }
  return (
    <>
      <input type="hidden" name="userId" value={String(selected?.id ?? "")} />
      <div className="field">
        <span>Участник клуба</span>
        {selected ? (
          <div className="panel panel-body detail-actions">
            <strong>
              {String(selected.name)} ·{" "}
              {String(selected.phone || selected.public_member_id)}
            </strong>
            <button
              type="button"
              className="button button-small button-outline"
              onClick={() => choose(null)}
            >
              Изменить
            </button>
          </div>
        ) : (
          <>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Имя или телефон"
              autoComplete="off"
              required
            />
            {r.loading && (
              <span role="status">
                <Spinner /> Поиск участников…
              </span>
            )}
            <FormMessage error={r.error?.message} />
            {r.error && (
              <button
                type="button"
                className="text-link"
                onClick={() => void r.refresh()}
              >
                Повторить поиск
              </button>
            )}
            {!!query && !r.loading && !r.error && (
              <div className="form-stack" role="listbox" aria-label="Участники">
                {items.length ? (
                  items.map((customer) => (
                    <button
                      type="button"
                      className="button button-outline button-full"
                      role="option"
                      aria-selected={false}
                      key={String(customer.id)}
                      onClick={() => choose(customer)}
                    >
                      {String(customer.name)} ·{" "}
                      {String(customer.phone || customer.public_member_id)}
                    </button>
                  ))
                ) : (
                  <p role="status">Участники не найдены. Измените запрос.</p>
                )}
              </div>
            )}
          </>
        )}
        <small>Найдите по имени или телефону и выберите нужного клиента</small>
      </div>
    </>
  );
}
