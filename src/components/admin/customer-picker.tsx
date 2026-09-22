"use client";
import { useEffect, useState, useId } from "react";
import { Field, FormMessage, Spinner, useResource } from "@/components/shared";
import type { Row } from "./tables";
export function CarNameField() {
  const id = useId();
  const r = useResource<{ items: Row[] }>("admin/club-content?kind=car");
  return (
    <Field
      label="Автомобиль"
      hint="Выберите из автопарка или введите название вручную"
    >
      <input
        name="carName"
        required
        maxLength={200}
        placeholder="Porsche Taycan"
        list={id}
      />
      <datalist id={id}>
        {r.data?.items.map((car) => (
          <option key={String(car.id)} value={String(car.title)} />
        ))}
      </datalist>
    </Field>
  );
}
export function CustomerPicker() {
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
  const options =
    selected && !items.some((item) => item.id === selected.id)
      ? [selected, ...items]
      : items;
  return (
    <>
      <Field
        label="Найти клиента"
        hint="Поиск по всем клиентам: имя, телефон или ID участника"
      >
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Начните вводить имя или телефон"
        />
      </Field>
      {r.loading && (
        <span role="status">
          <Spinner />
          Поиск клиентов…
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
      {!r.loading && !r.error && !items.length && (
        <p role="status">Клиенты не найдены. Измените запрос.</p>
      )}
      <Field label="Участник">
        <select
          name="userId"
          required
          value={String(selected?.id ?? "")}
          onChange={(e) =>
            setSelected(
              options.find((item) => item.id === e.target.value) ?? null,
            )
          }
        >
          <option value="" disabled>
            Выберите клиента
          </option>
          {options.map((c) => (
            <option key={String(c.id)} value={String(c.id)}>
              {String(c.name)} · {String(c.phone || c.public_member_id)}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}
