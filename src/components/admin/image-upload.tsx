"use client";
import { useState } from "react";
import { api, Field, FormMessage, Spinner } from "@/components/shared";
export function ImageUpload({
  value,
  onChange,
  busy,
  onBusy,
}: {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  onBusy: (value: boolean) => void;
}) {
  const [error, setError] = useState("");
  return (
    <div className="form-stack">
      {value && (
        <img
          src={value}
          alt="Предпросмотр изображения"
          style={{ maxHeight: 180, maxWidth: "100%", objectFit: "contain" }}
        />
      )}
      <Field label="Загрузить фото" hint="JPEG, PNG или WebP · до 5 МБ">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={async (e) => {
            const input = e.currentTarget,
              file = input.files?.[0];
            if (!file) return;
            setError("");
            if (
              file.size > 5 * 1024 * 1024 ||
              !["image/jpeg", "image/png", "image/webp"].includes(file.type)
            ) {
              setError("Выберите JPEG, PNG или WebP размером до 5 МБ");
              input.value = "";
              return;
            }
            onBusy(true);
            try {
              const data = new FormData();
              data.set("file", file);
              const result = await api<{ url: string }>("admin/media", {
                method: "POST",
                body: data,
              });
              onChange(result.url);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              onBusy(false);
              input.value = "";
            }
          }}
        />
      </Field>
      {busy && (
        <span role="status">
          <Spinner />
          Обработка изображения…
        </span>
      )}
      <Field
        label="Или ссылка на изображение"
        hint="https:// либо адрес уже загруженного изображения"
      >
        <input
          name="image"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={busy}
          maxLength={2000}
        />
      </Field>
      <FormMessage error={error} />
    </div>
  );
}
