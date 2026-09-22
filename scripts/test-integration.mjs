import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if(existsSync('.env.local'))process.loadEnvFile('.env.local');
const testUrl=process.env.TEST_DATABASE_URL;
if(!testUrl||new URL(testUrl).pathname!=='/rpm_club_test')throw new Error('TEST_DATABASE_URL must point to the dedicated rpm_club_test database');
const env={...process.env,DATABASE_URL:testUrl};
for(const args of [['node_modules/tsx/dist/cli.mjs','scripts/migrate.ts'],['node_modules/vitest/vitest.mjs','run',...process.argv.slice(2)]]){
 const result=spawnSync(process.execPath,args,{env,stdio:'inherit'});
 if(result.status!==0)process.exit(result.status??1);
}
