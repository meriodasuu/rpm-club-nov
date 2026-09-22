import { processJobs } from '../src/lib/jobs';
import { closePool } from '../src/lib/db';
try { console.log(JSON.stringify(await processJobs())); }
catch (error) { console.error('Worker failed', error instanceof Error ? error.name : 'UnknownError'); process.exitCode = 1; }
finally { await closePool(); }
