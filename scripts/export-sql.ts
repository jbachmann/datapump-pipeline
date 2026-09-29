import { mkdirSync, mkdtempSync } from 'node:fs';
import { basename, join } from 'node:path';
import { compose, projectRoot, reportError } from './lib/compose.ts';
import { pump, sql } from './lib/oracle.ts';
import { schemas, preflight } from './lib/statements.ts';

async function exportSql(): Promise<void> {
  process.umask(0o077);
  const base = join(projectRoot, 'artifacts/datapump');
  mkdirSync(base, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const artifacts = mkdtempSync(join(base, `${timestamp}-`));
  const prefix = `schema_metadata_${basename(artifacts)}`;
  const dumpfile = `${prefix}.dmp`;
  const sqlfile = `${prefix}.sql`;
  const exportLog = `${prefix}_export.log`;
  const importLog = `${prefix}_sqlfile.log`;
  const log = (name: string) => join(artifacts, name);
  let directory: string | undefined;
  try {
    if ((await compose(['ps', '--format', '{{.Health}}', 'oracle-source'])).trim() !== 'healthy') {
      throw new Error('oracle-source must be running and healthy. Start it with node scripts/compose.ts up -d --wait oracle-source.');
    }
    console.log('Checking source schemas and Data Pump directory...');
    await sql('oracle-source', preflight, { log: log('preflight.log') });
    const output = await sql('oracle-source', "select directory_path from all_directories where directory_name = 'DATA_PUMP_DIR';", {
      log: log('source-directory.log'),
    });
    const resolved = output.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim()).join('\n');
    if (!resolved.startsWith('/') || resolved.includes('\n')) throw new Error(`Could not resolve DATA_PUMP_DIR for oracle-source: ${resolved}`);
    directory = resolved;
    await compose(['exec', '-T', 'oracle-source', 'bash', '-c', 'test -d "$1" && test -r "$1" && test -w "$1" && test -x "$1"', 'bash', directory]);
    console.log('Exporting metadata from oracle-source/FREEPDB1...');
    await pump('oracle-source', 'expdp', [
      'DIRECTORY=DATA_PUMP_DIR', `DUMPFILE=${dumpfile}`, `LOGFILE=${exportLog}`,
      `SCHEMAS=${schemas.join(',')}`, 'CONTENT=METADATA_ONLY',
    ], log('export-client.log'));
    await compose(['cp', `oracle-source:${directory}/${dumpfile}`, log(dumpfile)], { stream: true });
    console.log('Generating SQL with impdp SQLFILE on oracle-source/FREEPDB1...');
    await pump('oracle-source', 'impdp', [
      'DIRECTORY=DATA_PUMP_DIR', `DUMPFILE=${dumpfile}`, `LOGFILE=${importLog}`, `SQLFILE=${sqlfile}`,
      `SCHEMAS=${schemas.join(',')}`, 'CONTENT=METADATA_ONLY',
      'TRANSFORM=SEGMENT_ATTRIBUTES:N', 'TRANSFORM=SEGMENT_CREATION:N',
    ], log('sqlfile-client.log'));
    await compose(['cp', `oracle-source:${directory}/${sqlfile}`, log(sqlfile)], { stream: true });
    console.log(`SQL file: ${log(sqlfile)}`);
  } finally {
    if (directory) {
      for (const filename of [exportLog, importLog]) {
        try { await compose(['cp', `oracle-source:${directory}/${filename}`, `${artifacts}/`]); }
        catch { /* A failed job may not have created a server log. */ }
      }
    }
    console.log(`Artifacts: ${artifacts}`);
  }
  console.log('SQL export completed successfully.');
}

exportSql().catch(reportError);
