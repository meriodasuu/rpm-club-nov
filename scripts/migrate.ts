import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { query, transaction, closePool } from '../src/lib/db/index';

async function main() {
  await query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir('db/migrations')).filter(x=>x.endsWith('.sql')).sort()) {
    const sql = await readFile(`db/migrations/${name}`, 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    await transaction(async tx=>{
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('rpm:migrations'))");
      const existing = await tx.query<{checksum:string}>('SELECT checksum FROM schema_migrations WHERE name=$1',[name]);
      if(existing.length) { if(existing[0].checksum!==checksum) throw new Error(`Migration changed: ${name}`); return; }
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);
      console.log(`Applied ${name}`);
    });
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(closePool);
