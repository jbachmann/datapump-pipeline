import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, realpathSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectRoot } from '../scripts/lib/compose.ts';

interface Call { args: string[]; sql: string; composeArgs: string[] }
function run(scenario: string, entry = 'migrate-metadata.ts') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'datapump ts test-')));
  try {
    cpSync(join(projectRoot, 'scripts'), join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    mkdirSync(join(root, 'bin'));
    cpSync(join(projectRoot, 'tests/fixtures/docker.ts'), join(root, 'bin/docker'));
    chmodSync(join(root, 'bin/docker'), 0o700);
    const calls = join(root, 'calls.jsonl');
    const result = spawnSync(process.execPath, [join(root, 'scripts', entry), ...(entry === 'compose.ts' ? ['ps'] : [])], {
      cwd: tmpdir(), encoding: 'utf8',
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, CALLS: calls, SCENARIO: scenario },
    });
    assert.ifError(result.error);
    assert.ok(existsSync(calls), result.stderr);
    const entries: Call[] = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const logs: Record<string, string> = {};
    if (entry !== 'compose.ts') {
      const base = join(root, 'artifacts/datapump');
      const artifact = join(base, readdirSync(base)[0]);
      for (const file of readdirSync(artifact)) logs[file] = readFileSync(join(artifact, file), 'utf8');
    }
    return { ...result, entries, logs, root };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const reset = (calls: Call[]) => calls.findIndex((call) => call.sql.includes('DROP USER'));
const revoke = (calls: Call[]) => calls.some((call) => call.sql.includes('revoke index on IAM.PERMISSIONS'));

test('SQL export generates and copies SQL using only the source database', () => {
  const result = run('success', 'export-sql.ts');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.entries.every((call) => !call.args.some((arg) => arg.includes('oracle-destination'))));
  assert.equal(reset(result.entries), -1);
  assert.ok(!result.entries.some((call) => /grant index on|compile_schema/.test(call.sql)));
  const pumps = result.entries.filter((call) => call.args.includes('expdp') || call.args.includes('impdp'));
  assert.equal(pumps.length, 2);
  assert.ok(pumps[0].args.includes('expdp'));
  const args = pumps[1].args;
  assert.ok(args.includes('impdp'));
  assert.ok(args.includes('oracle-source'));
  assert.ok(args.includes('TRANSFORM=SEGMENT_ATTRIBUTES:N'));
  assert.ok(args.includes('TRANSFORM=SEGMENT_CREATION:N'));
  assert.ok(!args.some((arg) => /^(INCLUDE|EXCLUDE)=/.test(arg)));
  assert.equal(args.find((arg) => arg.startsWith('DUMPFILE=')), pumps[0].args.find((arg) => arg.startsWith('DUMPFILE=')));
  for (const call of pumps) assert.ok(call.args.includes('CONTENT=METADATA_ONLY'));
  const filename = args.find((arg) => arg.startsWith('SQLFILE='))!.slice('SQLFILE='.length);
  assert.match(result.logs[filename], /CREATE TABLE/);
  assert.match(result.stdout, /SQL file:.*\.sql/);
});

for (const scenario of ['unavailable', 'export_error', 'import_error', 'sql_copy_error']) {
  test(`SQL export ${scenario} reports failure`, () => {
    const result = run(scenario, 'export-sql.ts');
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /completed successfully|SQL file:/);
    assert.match(result.stdout, /Artifacts:/);
    assert.equal(reset(result.entries), -1);
    if (scenario === 'unavailable' || scenario === 'export_error') {
      assert.ok(!result.entries.some((call) => call.args.includes('impdp')));
    }
    if (scenario === 'import_error') {
      assert.equal(result.status, 5);
      assert.match(result.logs['sqlfile-client.log'], /completed with errors/);
      assert.ok(result.entries.some((call) => call.args[0] === 'cp' && call.args[1].endsWith('_sqlfile.log')));
    }
  });
}

for (const scenario of ['unavailable', 'export_error', 'transfer_error']) {
  test(`${scenario} stops before destination reset`, () => {
    const result = run(scenario);
    assert.notEqual(result.status, 0);
    assert.equal(reset(result.entries), -1);
    assert.ok(!result.entries.some((call) => call.args.includes('impdp')));
    assert.match(result.stdout, /Artifacts:/);
    if (scenario === 'export_error') {
      assert.equal(result.status, 5);
      assert.match(result.logs['export-client.log'], /completed with errors/);
      assert.ok(result.entries.some((call) => call.args[0] === 'cp' && call.args[1].endsWith('_export.log')));
    }
  });
}
for (const scenario of ['import_error', 'indexes_error', 'compile_error', 'revoke_error']) {
  test(`${scenario} reports failure and cleans up temporary privileges`, () => {
    const result = run(scenario);
    assert.notEqual(result.status, 0);
    assert.ok(reset(result.entries) >= 0);
    assert.doesNotMatch(result.stdout, /completed successfully/);
    assert.equal(revoke(result.entries), scenario !== 'import_error');
    if (scenario === 'revoke_error') assert.match(result.stderr, /Failed to revoke/);
  });
}
test('successful migration preserves ordering, reset dependencies, and transforms', () => {
  const result = run('success');
  assert.equal(result.status, 0, result.stderr);
  const calls = result.entries;
  const transfer = calls.findIndex((call) => call.args[0] === 'cp' && call.args.at(-1)?.startsWith('oracle-destination:'));
  const firstImport = calls.findIndex((call) => call.args.includes('impdp'));
  assert.ok(transfer < reset(calls) && reset(calls) < firstImport);
  assert.ok(calls[reset(calls)].sql.indexOf("'IAM'") < calls[reset(calls)].sql.indexOf("'INDEX_SCHEMA'"));
  const pumps = calls.filter((call) => call.args.includes('expdp') || call.args.includes('impdp'));
  assert.equal(pumps.length, 3);
  for (const call of pumps) {
    assert.ok(call.args.includes('CONTENT=METADATA_ONLY'));
    if (call.args.includes('impdp')) {
      assert.ok(call.args.includes('TRANSFORM=SEGMENT_ATTRIBUTES:N'));
      assert.ok(call.args.includes('TRANSFORM=SEGMENT_CREATION:N'));
    }
  }
  assert.ok(revoke(calls));
  assert.ok(calls.findIndex((call) => call.sql.includes('grant index on')) < calls.findIndex((call) => call.args.includes('INCLUDE=INDEX,CONSTRAINT,REF_CONSTRAINT')));
  assert.match(result.stdout, /completed successfully/);
});
test('existing INDEX grant is preserved', () => {
  const result = run('existing_grant');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!revoke(result.entries));
  assert.ok(!result.entries.some((call) => call.sql.includes('grant index on')));
});
test('Compose wrapper resolves project paths from any working directory', () => {
  const result = run('success', 'compose.ts');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /healthy/);
  const args = result.entries[0].composeArgs;
  assert.equal(args[args.indexOf('--env-file') + 1], join(result.root, '.env'));
  assert.equal(args[args.indexOf('--file') + 1], join(result.root, 'docker-compose.yml'));
  assert.equal(args[args.indexOf('--project-name') + 1], 'datapump-pipeline-test');
});
