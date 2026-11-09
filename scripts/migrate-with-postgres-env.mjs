if (!process.env.POSTGRES_DB || !process.env.POSTGRES_USER || !process.env.POSTGRES_PASSWORD) {
  throw new Error("PostgreSQL administrator environment is incomplete");
}
const url = new URL(`postgresql://rpm-club-db/${process.env.POSTGRES_DB}`);
url.username = process.env.POSTGRES_USER;
url.password = process.env.POSTGRES_PASSWORD;
process.env.DATABASE_URL = url.href;
process.env.DATABASE_PRIVATE_NETWORK = "1";
await import("./migrate.ts");
