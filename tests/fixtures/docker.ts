#!/usr/bin/env -S node --
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const operation = args.slice(args.indexOf('--file') + 2);
const sql = operation[0] === 'exec' && operation.join(' ').includes('sqlplus') ? readFileSync(0, 'utf8') : '';
if (!process.env.CALLS) throw new Error('CALLS is required');
appendFileSync(process.env.CALLS, `${JSON.stringify({ args: operation, sql, composeArgs: args })}\n`);
const scenario = process.env.SCENARIO;
if (operation[0] === 'ps') console.log(scenario === 'unavailable' ? 'unhealthy' : 'healthy');
else if (operation[0] === 'cp' && operation.at(-1)?.startsWith('oracle-destination:') && scenario === 'transfer_error') process.exit(1);
else if (operation[0] === 'exec') {
  if (sql.includes('select directory_path')) console.log('/oracle/dpdump');
  else if (sql.includes('select count(*) from dba_tab_privs')) console.log(scenario === 'existing_grant' ? '1' : '0');
  else if (operation.includes('expdp') && scenario === 'export_error') { console.log('Job completed with errors'); process.exit(5); }
  else if (operation.includes('impdp') && scenario === 'import_error') { console.log('Job completed with errors'); process.exit(5); }
  else if (operation.includes('INCLUDE=INDEX,CONSTRAINT,REF_CONSTRAINT') && scenario === 'indexes_error') process.exit(5);
  else if (sql.includes('dbms_utility.compile_schema') && scenario === 'compile_error') process.exit(1);
  else if (sql.includes('revoke index on') && scenario === 'revoke_error') process.exit(1);
}
