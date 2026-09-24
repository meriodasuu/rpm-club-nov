import { setTimeout } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { processJobs } from "../src/lib/jobs";
import { closePool } from "../src/lib/db";

const shutdown = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => shutdown.abort());
try {
  while (!shutdown.signal.aborted) {
    const started = Date.now();
    try {
      const result = await processJobs();
      await writeFile("/tmp/rpm-worker-heartbeat", String(Date.now()));
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    } catch (error) {
      console.error(
        "Worker iteration failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
    await setTimeout(
      Math.max(1000, 60000 - (Date.now() - started)),
      undefined,
      { signal: shutdown.signal },
    ).catch((error) => {
      if (error.name !== "AbortError") throw error;
    });
  }
} finally {
  await closePool();
}
