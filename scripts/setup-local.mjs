import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { stdio: "inherit", ...options });
  if (r.status !== 0) throw new Error(`${command} failed`);
  return r;
}
if (!existsSync(".env.local")) {
  let env = readFileSync(".env.example", "utf8").replace(
    "LOCAL_PREVIEW=0",
    "LOCAL_PREVIEW=1",
  );
  for (const name of [
    "SESSION_SECRET",
    "ENCRYPTION_KEY",
    "INTEGRATION_API_KEY",
    "CRON_SECRET",
  ])
    env = env.replace(
      new RegExp("^" + name + "=$", "m"),
      name + "=" + randomBytes(32).toString("base64"),
    );
  writeFileSync(".env.local", env, { flag: "wx" });
  console.log("Created local configuration; secrets are not printed.");
}
process.loadEnvFile(".env.local");
const db = new URL(process.env.DATABASE_URL ?? "");
if (
  !["127.0.0.1", "localhost"].includes(db.hostname) ||
  db.pathname !== "/rpm_club"
)
  throw new Error(
    "Local setup requires localhost/rpm_club; refusing to seed another database",
  );
const exists =
  spawnSync("docker", ["inspect", "rpm-club-db"], { stdio: "ignore" })
    .status === 0;
run(
  "docker",
  exists ? ["start", "rpm-club-db"] : ["compose", "up", "-d", "--wait"],
);
let ready = false;
for (let i = 0; i < 20; i++) {
  if (
    spawnSync(
      "docker",
      ["exec", "rpm-club-db", "pg_isready", "-U", "rpm", "-d", "rpm_club"],
      { stdio: "ignore" },
    ).status === 0
  ) {
    ready = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!ready) throw new Error("PostgreSQL is not ready");
const test = spawnSync(
  "docker",
  [
    "exec",
    "rpm-club-db",
    "psql",
    "-U",
    "rpm",
    "-d",
    "rpm_club",
    "-tAc",
    "SELECT 1 FROM pg_database WHERE datname='rpm_club_test'",
  ],
  { encoding: "utf8" },
);
if (test.status !== 0) throw new Error("Database lookup failed");
if (test.stdout.trim() !== "1")
  run("docker", [
    "exec",
    "rpm-club-db",
    "createdb",
    "-U",
    "rpm",
    "rpm_club_test",
  ]);
for (const file of ["scripts/migrate.ts", "scripts/seed.ts"])
  run(process.execPath, [
    "--env-file=.env.local",
    "node_modules/tsx/dist/cli.mjs",
    file,
  ]);
console.log(
  "Local RPM Club is ready. Run npm run dev, then open http://127.0.0.1:3001",
);
