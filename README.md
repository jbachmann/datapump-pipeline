# Data Pump development database foundation

This folder is self-contained. Copy or move the entire folder to a new location;
it needs no files, Node.js dependencies, or configuration from the parent project.
It provides two local Oracle Free databases and a script to migrate schema
metadata between them using Oracle Data Pump.

Requirements: Node.js 24+, Docker with Compose supporting `up --wait`, and access to the
Oracle container registry image pinned in `docker-compose.yml`.

## Start the databases

From this folder, copy the example configuration if `.env` does not exist:

```sh
cp -n .env.example .env
```

Set `ORACLE_PWD` in `.env` to your development database password, then start:

```sh
npm start
node scripts/compose.ts ps
```

All wrapper commands load `.env` automatically. An exported `ORACLE_PWD` takes
precedence; run `unset ORACLE_PWD` to use the file's value. It initializes both
databases on first creation; changing it does not reset passwords in existing
volumes. Do not commit credentials or use expanded Compose configuration as a
shareable artifact: it includes the environment password.

The wrapper resolves paths relative to itself, fixes the project name to
`datapump-pipeline-test`, and explicitly loads this folder's `.env`. Its containers,
network, and named volumes are separate from the original project's resources.

| Database | Host connection | Connection inside the Compose network |
| --- | --- | --- |
| Source | `127.0.0.1:1621/FREEPDB1` | `oracle-source:1521/FREEPDB1` |
| Destination | `127.0.0.1:1622/FREEPDB1` | `oracle-destination:1521/FREEPDB1` |

Use `SYSTEM` with the password supplied above for development connections.
The application schema owners have no password authentication. Host ports bind
to loopback. Override ports with exported `ORACLE_SOURCE_PORT`,
`ORACLE_DESTINATION_PORT`, `ORACLE_SOURCE_EM_PORT` (default 5600), and
`ORACLE_DESTINATION_EM_PORT` (default 5601).

## Migrate metadata

Start both databases with `npm start`, then run:

```sh
npm run migrate:metadata
# Equivalent:
node scripts/migrate-metadata.ts
```

The script targets only `oracle-source` and `oracle-destination`, using
`FREEPDB1` in both containers. It exports `IAM`, `CATALOG`, `COMMERCE`, `FINANCE`,
`INDEX_SCHEMA`, `SCHEMA_READER`, and `LIMITED_READER` together to preserve
cross-schema dependencies. Both export and import use `CONTENT=METADATA_ONLY`;
application rows are never transferred. Import uses
`TRANSFORM=SEGMENT_ATTRIBUTES:N` and `TRANSFORM=SEGMENT_CREATION:N`.
These omit source segment attributes and explicit segment-creation clauses;
destination defaults still control segment creation.

Import runs in two passes: tables and other metadata first, then indexes and
constraints. The fixture owns three indexes in `INDEX_SCHEMA` on
`IAM.PERMISSIONS`. Data Pump needs an `INDEX` object grant on that table to
recreate them as `SYSTEM`. The script adds this grant temporarily between
passes and revokes it on exit, including after an import failure. If that grant
was already present in the exported metadata, it is preserved. A failed revoke
is reported as a migration failure and recorded in `index-grant.log`.
After import, the script recompiles invalid objects in the seven schemas and
fails if any package or view remains invalid; see `compile.log` for details.

**Every run drops all seven destination schemas with `CASCADE`, deleting their
existing objects and data.** Reset begins only after preflight, export, and dump
transfer succeed. The source schemas are not reset. Reset/import cannot be
rolled back; if either fails, fix the reported issue and rerun the script.
Do not run concurrent migrations against the same destination.

No host Oracle client or Node.js dependencies are required. The script uses
the container clients as `SYSTEM` and supplies each container's `ORACLE_PWD`
through standard input. The value must match the actual database password.
Both containers must be healthy and their PDB `DATA_PUMP_DIR` paths must be
accessible to Oracle. Docker Compose must support `exec`, `cp`, and formatted
`ps` output.

Each run retains its dump and logs in `artifacts/datapump/<run-id>/` (ignored by
Git). Unique dump/log files also remain in the containers' Data Pump directories.
The script prints the artifact path on completion or failure, returns nonzero
for Data Pump errors, and attempts to collect server logs even after failure.
Artifacts can contain schema definitions and security metadata; keep them
private and remove old runs and container copies when no longer needed.

Run `npm test` for the TypeScript tests using Node's built-in test runner.
For development, install the type-checking tools with `npm ci`, then run
`npm run typecheck`. Runtime scripts need no npm dependencies or build step.

Host-side orchestration and tests are written in TypeScript. The source startup
hook remains Bash because it runs inside the Oracle container. Small Bash
commands inside the containers handle Oracle client authentication and file
permissions without requiring Node.js in the database image.

## Export metadata as SQL

Only the source database needs to be running:

```sh
node scripts/compose.ts up -d --wait oracle-source
npm run export:sql
# Equivalent:
node scripts/export-sql.ts
```

This exports the same seven schemas with `CONTENT=METADATA_ONLY`, then runs
`impdp` on the source using `SQLFILE` and the same segment transforms as the
migration. It generates all metadata in one pass, including indexes and
constraints. No destination connection, schema reset, temporary grants, or
compilation is performed.

Data Pump still requires a database connection to process the dump; this command
uses `oracle-source/FREEPDB1` for both steps. Oracle's
[SQLFILE parameter](https://docs.oracle.com/en/database/oracle/oracle-database/21/sutil/oracle-datapump-import-utility.html)
writes the prepared DDL without executing it. Review the SQL before running it
manually; it is Data Pump output, not the migration script's reset and grant workflow.

The command prints the generated `.sql` path and retains it alongside the `.dmp`
and client/server logs in `artifacts/datapump/<run-id>/`. Unique files also remain
in the source container's `DATA_PUMP_DIR`. Failures return nonzero and retain
available logs; a SQL file is only reported as ready after generation and copying
both succeed.

## Included initialization

- `docker-compose.yml`: pinned Oracle image, separate persistent source and
  destination volumes, mounts, and database health checks.
- `oracle/source-init/01-seed.sql`: the schema fixture, originally copied
  from `test/docker/oracle/source-init/01-seed.sql` in oracle-schema-pipeline.
  It creates 98 tables, 5 views, 2 packages, and 2 private synonyms across
  `IAM`, `CATALOG`, `COMMERCE`, and `FINANCE`, including constraints, identity
  columns, sequences, indexes, comments, and cross-schema relationships. `INDEX_SCHEMA` owns supporting
  indexes; `SCHEMA_READER` and `LIMITED_READER` are restricted proxy accounts.
  `COMMERCE.order_management` and `CATALOG.inventory_management` each expose two
  functions and two procedures using local tables and cross-schema synonyms.
  They cover order totals, SKU lookup, order status history, stock availability,
  reservations, and product status. Procedures leave commits to the caller.
  Package compilation is checked before the seed completion marker is created.
- `oracle/source-startup/01-seed-if-needed.sh`: seeds a fresh source, skips a
  completed seed on restart, and rebuilds fixture schemas after an interrupted
  seed. The copied recovery list also includes `INDEX_SCHEMA`, so a failure
  after creating that account can be recovered on restart.

The seed contains schema definitions only, with no application rows. Add data
fixtures when developing data transfer tests. The destination starts without
these application schemas. Source health waits for the expected table/view
counts and the final `IAM.SOURCE_SEED_COMPLETE` marker; destination health waits
for `FREEPDB1` to be open for reads and writes. TCP listener registration may
briefly lag these checks, so clients should retry initial connections.

The startup hook runs against persisted databases too. An incomplete seed causes
it to drop and recreate the fixture accounts and their objects. Use this setup
only for disposable development databases. Edits to seed SQL do not apply to a
volume that already has the completion marker.

## Inspect, stop, and reset

Open a local SQL session without putting a password in process arguments:

```sh
node scripts/compose.ts exec oracle-source sqlplus / as sysdba
```

In SQL*Plus, run `ALTER SESSION SET CONTAINER = FREEPDB1;` before inspecting the
application schemas. Substitute `oracle-destination` to inspect the destination.

Stop containers while preserving their data:

```sh
node scripts/compose.ts down
```

To delete **both databases and all their data** and start fresh:

```sh
node scripts/compose.ts down --volumes
node scripts/compose.ts up -d --wait --wait-timeout 1200
```

Moving this folder does not move Docker-managed data. On the same Docker daemon,
the fixed project name reuses this setup's existing named volumes. On a different
daemon, startup creates fresh databases. Separate copies using this wrapper also
share the same project, so change the project name and ports if independent
copies must run concurrently.

The parent project's extraction, clone, benchmark, and integration runners are
not required for initialization and are not copied. The migration script uses
the existing PDB `DATA_PUMP_DIR` objects and copies dumps between the containers
through local artifacts; no shared volume is needed.
