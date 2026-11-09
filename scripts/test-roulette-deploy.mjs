import { spawnSync } from "node:child_process";

const url = new URL(process.env.DATABASE_URL);
url.pathname = "/rpm_club_test";
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/roulette.integration.test.ts"], {
  env: { ...process.env, DATABASE_URL: url.href, NODE_ENV: "test" },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
