import Link from "next/link";
export default function NotFound() {
  return (
    <main className="standalone">
      <h1>Страница не найдена</h1>
      <p>Вернитесь в RPM Club, чтобы продолжить.</p>
      <Link className="button" href="/home">
        В клуб
      </Link>
    </main>
  );
}
