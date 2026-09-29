import { mkdirSync, mkdtempSync } from 'node:fs';
import { basename, join } from 'node:path';
import { compose, projectRoot, reportError } from './lib/compose.ts';
import { pump, sql, type Service } from './lib/oracle.ts';
import { schemas, preflight, reset, compile } from './lib/statements.ts';

async function migrate(): Promise<void> {
  process.umask(0o077);
  const base = join(projectRoot, 'artifacts/datapump');
  mkdirSync(base, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const artifacts = mkdtempSync(join(base, `${timestamp}-`));
  const prefix = `schema_metadata_${basename(artifacts)}`;
  const dumpfile = `${prefix}.dmp`;
  const exportLog = `${prefix}_export.log`;
  const importLog = `${prefix}_import.log`;
  const indexesLog = `${prefix}_indexes.log`;
  const directories: Partial<Record<Service, string>> = {};
  const log = (name: string) => join(artifacts, name);
  let temporaryIndexGrant = false;
  let failure: unknown;
  const importMetadata = (args: string[], clientLog: string) => pump('oracle-destination', 'impdp', [
    'DIRECTORY=DATA_PUMP_DIR', `DUMPFILE=${dumpfile}`, `SCHEMAS=${schemas.join(',')}`,
    'CONTENT=METADATA_ONLY', 'TRANSFORM=SEGMENT_ATTRIBUTES:N', 'TRANSFORM=SEGMENT_CREATION:N', ...args,
  ], log(clientLog));
  try {
    for (const service of ['oracle-source', 'oracle-destination'] as const) {
      if ((await compose(['ps', '--format', '{{.Health}}', service])).trim() !== 'healthy') {
        throw new Error(`${service} must be running and healthy. Start the databases with npm start.`);
      }
    }
    console.log('Checking source schemas and destination connectivity...');
    await sql('oracle-source', preflight, { log: log('preflight.log') });
    for (const service of ['oracle-source', 'oracle-destination'] as const) {
      const output = await sql(service, "select directory_path from all_directories where directory_name = 'DATA_PUMP_DIR';", {
        log: log(`${service === 'oracle-source' ? 'source' : 'destination'}-directory.log`),
      });
      const directory = output.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim()).join('\n');
      if (!directory.startsWith('/') || directory.includes('\n')) throw new Error(`Could not resolve DATA_PUMP_DIR for ${service}: ${directory}`);
      directories[service] = directory;
      await compose(['exec', '-T', service, 'bash', '-c', 'test -d "$1" && test -r "$1" && test -w "$1" && test -x "$1"', 'bash', directory]);
    }
    console.log('Exporting metadata from oracle-source/FREEPDB1...');
    await pump('oracle-source', 'expdp', [
      'DIRECTORY=DATA_PUMP_DIR', `DUMPFILE=${dumpfile}`, `LOGFILE=${exportLog}`,
      `SCHEMAS=${schemas.join(',')}`, 'CONTENT=METADATA_ONLY',
    ], log('export-client.log'));
    console.log('Transferring the completed dump to oracle-destination...');
    await compose(['cp', `oracle-source:${directories['oracle-source']}/${dumpfile}`, log(dumpfile)], { stream: true });
    const destinationDump = `${directories['oracle-destination']}/${dumpfile}`;
    await compose(['cp', log(dumpfile), `oracle-destination:${destinationDump}`], { stream: true });
    await compose(['exec', '-T', '--user', 'root', 'oracle-destination', 'bash', '-c',
      'set -e; chown oracle:oinstall "$1"; chmod 600 "$1"', 'bash', destinationDump]);
    await compose(['exec', '-T', 'oracle-destination', 'test', '-r', destinationDump]);
    console.log(`Resetting destination schemas: ${schemas.join(',')}`);
    console.log('WARNING: DROP USER CASCADE removes all existing objects and data in these destination schemas.');
    await sql('oracle-destination', reset, { log: log('reset.log') });
    console.log('Importing metadata into oracle-destination/FREEPDB1...');
    // Defer constraints to preserve their cross-owner indexes in the second pass.
    await importMetadata([`LOGFILE=${importLog}`, 'EXCLUDE=INDEX,CONSTRAINT,REF_CONSTRAINT'], 'import-client.log');
    const existingGrant = (await sql('oracle-destination', `select count(*) from dba_tab_privs
      where owner='IAM' and table_name='PERMISSIONS' and grantee='INDEX_SCHEMA' and privilege='INDEX';`,
    { log: log('index-grant-check.log') })).replace(/\s/g, '');
    if (existingGrant === '0') {
      temporaryIndexGrant = true;
      await sql('oracle-destination', 'grant index on IAM.PERMISSIONS to INDEX_SCHEMA;', { log: log('index-grant.log') });
    } else if (existingGrant !== '1') throw new Error('Could not check the cross-schema INDEX grant');
    console.log('Importing indexes and constraints...');
    await importMetadata([`LOGFILE=${indexesLog}`, 'INCLUDE=INDEX,CONSTRAINT,REF_CONSTRAINT'], 'indexes-client.log');
    console.log('Compiling imported schemas and checking package/view validity...');
    await sql('oracle-destination', compile, { log: log('compile.log') });
  } catch (error) {
    failure = error;
  } finally {
    if (temporaryIndexGrant) {
      try {
        await sql('oracle-destination', 'revoke index on IAM.PERMISSIONS from INDEX_SCHEMA;', { log: log('index-grant.log'), append: true });
      } catch (error) {
        console.error('Failed to revoke temporary INDEX grant on IAM.PERMISSIONS from INDEX_SCHEMA; see index-grant.log.');
        failure ??= error;
      }
    }
    for (const [service, filename] of [
      ['oracle-source', exportLog], ['oracle-destination', importLog], ['oracle-destination', indexesLog],
    ] as const) {
      if (directories[service]) {
        try { await compose(['cp', `${service}:${directories[service]}/${filename}`, `${artifacts}/`]); }
        catch { /* A failed job may not have created a server log. */ }
      }
    }
    console.log(`Artifacts: ${artifacts}`);
  }
  if (failure) {
    console.error('Metadata migration failed; inspect the retained logs. A reset/import failure may leave destination schemas incomplete.');
    throw failure;
  }
  console.log('Metadata migration completed successfully.');
}

migrate().catch(reportError);
