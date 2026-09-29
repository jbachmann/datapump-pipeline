"""Exercise migration ordering and failure handling without a Docker daemon."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MOCK_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
operation = args[args.index('--file') + 2:]
sql = sys.stdin.read() if operation[0] == 'exec' and 'sqlplus' in ' '.join(operation) else ''
with open(os.environ['CALLS'], 'a') as f:
    f.write(json.dumps({'args': operation, 'sql': sql}) + '\n')
scenario = os.environ['SCENARIO']
if operation[0] == 'ps':
    print('unhealthy' if scenario == 'unavailable' else 'healthy')
elif operation[0] == 'exec':
    if 'select directory_path' in sql:
        print('/oracle/dpdump')
    elif 'select count(*) from dba_tab_privs' in sql:
        print('0')
    elif 'expdp' in operation and scenario == 'export_error':
        print('Job completed with errors')
        sys.exit(5)
    elif 'impdp' in operation and scenario == 'import_error':
        print('Job completed with errors')
        sys.exit(5)
    elif 'INCLUDE=INDEX,CONSTRAINT,REF_CONSTRAINT' in operation and scenario == 'indexes_error':
        print('Index import completed with errors')
        sys.exit(5)
    elif 'dbms_utility.compile_schema' in sql and scenario == 'compile_error':
        print('Imported packages or views remain invalid')
        sys.exit(1)
'''


class MigrationTests(unittest.TestCase):
    def run_migration(self, scenario):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'scripts').mkdir()
            (root / 'bin').mkdir()
            for name in ('compose.sh', 'migrate-metadata.sh'):
                shutil.copy(ROOT / 'scripts' / name, root / 'scripts' / name)
            docker = root / 'bin' / 'docker'
            docker.write_text(MOCK_DOCKER)
            docker.chmod(0o700)
            calls = root / 'calls.jsonl'
            env = dict(os.environ, PATH=f"{root / 'bin'}:{os.environ['PATH']}",
                       CALLS=str(calls), SCENARIO=scenario)
            result = subprocess.run(['bash', str(root / 'scripts/migrate-metadata.sh')],
                                    cwd='/', env=env, text=True, capture_output=True)
            entries = [json.loads(line) for line in calls.read_text().splitlines()]
            return result, entries

    def test_unavailable_database_never_resets(self):
        result, entries = self.run_migration('unavailable')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('DROP USER' in c['sql'] for c in entries))
        self.assertFalse(any('expdp' in c['args'] for c in entries))
        self.assertIn('Artifacts:', result.stdout)

    def test_export_completed_with_errors_never_resets(self):
        result, entries = self.run_migration('export_error')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('DROP USER' in c['sql'] for c in entries))
        self.assertFalse(any('impdp' in c['args'] for c in entries))
        self.assertTrue(any(c['args'][0] == 'cp' and '_export.log' in c['args'][1] for c in entries))

    def test_import_completed_with_errors_is_failure(self):
        result, entries = self.run_migration('import_error')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any('DROP USER' in c['sql'] for c in entries))
        self.assertNotIn('completed successfully', result.stdout)

    def test_transfer_precedes_reset_and_import_has_transforms(self):
        result, entries = self.run_migration('success')
        self.assertEqual(result.returncode, 0, result.stderr)
        reset = next(i for i, c in enumerate(entries) if 'DROP USER' in c['sql'])
        transfer = next(i for i, c in enumerate(entries)
                        if c['args'][0] == 'cp' and c['args'][-1].startswith('oracle-destination:'))
        imp = next(i for i, c in enumerate(entries) if 'impdp' in c['args'])
        self.assertLess(transfer, reset)
        self.assertLess(reset, imp)
        # Cross-owner constraint indexes cannot be dropped before their tables.
        self.assertLess(entries[reset]['sql'].index("'IAM'"),
                        entries[reset]['sql'].index("'INDEX_SCHEMA'"))
        for utility in ('expdp', 'impdp'):
            args = next(c['args'] for c in entries if utility in c['args'])
            self.assertIn('CONTENT=METADATA_ONLY', args)
        self.assertIn('TRANSFORM=SEGMENT_ATTRIBUTES:N', entries[imp]['args'])
        self.assertIn('TRANSFORM=SEGMENT_CREATION:N', entries[imp]['args'])
        self.assertTrue(any('revoke index on IAM.PERMISSIONS' in c['sql'] for c in entries))

    def test_index_failure_revokes_temporary_grant(self):
        result, entries = self.run_migration('indexes_error')
        self.assertNotEqual(result.returncode, 0)
        grant = next(i for i, c in enumerate(entries) if 'grant index on IAM.PERMISSIONS' in c['sql'])
        indexes = next(i for i, c in enumerate(entries) if 'INCLUDE=INDEX,CONSTRAINT,REF_CONSTRAINT' in c['args'])
        revoke = next(i for i, c in enumerate(entries) if 'revoke index on IAM.PERMISSIONS' in c['sql'])
        self.assertLess(grant, indexes)
        self.assertLess(indexes, revoke)
        self.assertNotIn('completed successfully', result.stdout)

    def test_invalid_packages_fail_and_revoke_temporary_grant(self):
        result, entries = self.run_migration('compile_error')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any('revoke index on IAM.PERMISSIONS' in c['sql'] for c in entries))
        self.assertNotIn('completed successfully', result.stdout)
        self.assertIn('Artifacts:', result.stdout)


if __name__ == '__main__':
    unittest.main()
