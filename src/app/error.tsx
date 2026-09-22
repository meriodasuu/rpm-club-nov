"use client";
import { Failure } from "@/components/shared";
export default function ErrorPage({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <main className="standalone">
      <Failure
        error={new Error("Сервис временно недоступен. Повторите попытку.")}
        retry={reset}
      />
    </main>
  );
}
