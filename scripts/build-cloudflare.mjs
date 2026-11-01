// Independent Cloudflare target; excludes Sites authentication and hosting plugins.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const cli = new URL('./cli.js', import.meta.resolve('vinext'));
const result=spawnSync(process.execPath,[fileURLToPath(cli),'build'],{stdio:'inherit',env:{...process.env,QUBIT_HOST:'cloudflare'}});
if(result.error) throw result.error;
if(result.status!==0) process.exit(result.status??1);
// The retained Vite adapter emits this obsolete field. Current Wrangler uses
// its former default behavior and rejects the field itself.
const output='dist/server/wrangler.json';
const config=JSON.parse(readFileSync(output,'utf8'));
delete config.legacy_env;
writeFileSync(output,JSON.stringify(config));
