#!/bin/bash
set -euo pipefail
umask 077
exec 3>&1 4>&2

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
schemas=IAM,CATALOG,COMMERCE,FINANCE,INDEX_SCHEMA,SCHEMA_READER,LIMITED_READER
schema_sql="'IAM','CATALOG','COMMERCE','FINANCE','INDEX_SCHEMA','SCHEMA_READER','LIMITED_READER'"
mkdir -p "$project_root/artifacts/datapump"
artifacts=$(mktemp -d "$project_root/artifacts/datapump/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
run_id=${artifacts##*/}
dumpfile="schema_metadata_${run_id}.dmp"
export_log="schema_metadata_${run_id}_export.log"
import_log="schema_metadata_${run_id}_import.log"
indexes_log="schema_metadata_${run_id}_indexes.log"
source_dir=
destination_dir=
temporary_index_grant=0

compose() { bash "$project_root/scripts/compose.sh" "$@"; }

# Read passwords inside the container and send them over standard input.
# Never enable tracing or put credentials in arguments/parameter files.
sql() {
  compose exec -T "$1" bash -c '
    set -euo pipefail
    case "$ORACLE_PWD" in
      *\"*|*$'"'"'\n'"'"'*|*$'"'"'\r'"'"'*) echo "Unsupported password characters" >&2; exit 1 ;;
    esac
    {
      printf "%s\n" "whenever oserror exit failure" "whenever sqlerror exit failure" "set define off echo off"
      printf '\''connect system/"%s"@localhost:1521/FREEPDB1\n'\'' "$ORACLE_PWD"
      cat
    } | "$ORACLE_HOME/bin/sqlplus" -L -s /nolog
  ' <<SQL
whenever oserror exit failure
whenever sqlerror exit failure
set heading off feedback off pages 0 verify off echo off lines 32767 trimspool on
$2
exit
SQL
}

finish() {
  result=$?
  trap - EXIT
  if [ "$temporary_index_grant" -eq 1 ]; then
    if ! sql oracle-destination 'revoke index on IAM.PERMISSIONS from INDEX_SCHEMA;' >>"$artifacts/index-grant.log" 2>&1; then
      echo "Failed to revoke temporary INDEX grant on IAM.PERMISSIONS from INDEX_SCHEMA; see index-grant.log." >&4
      result=1
    fi
  fi
  # A failing job can still produce a useful server-side log.
  if [ -n "$source_dir" ]; then
    compose cp "oracle-source:$source_dir/$export_log" "$artifacts/" >/dev/null 2>&1 || true
  fi
  if [ -n "$destination_dir" ]; then
    compose cp "oracle-destination:$destination_dir/$import_log" "$artifacts/" >/dev/null 2>&1 || true
    compose cp "oracle-destination:$destination_dir/$indexes_log" "$artifacts/" >/dev/null 2>&1 || true
  fi
  if [ "$result" -eq 0 ]; then
    echo "Metadata migration completed successfully." >&3
  else
    echo "Metadata migration failed; inspect the retained logs. A reset/import failure may leave destination schemas incomplete." >&4
  fi
  echo "Artifacts: $artifacts" >&3
  exit "$result"
}
trap finish EXIT

for service in oracle-source oracle-destination; do
  if [ "$(compose ps --format '{{.Health}}' "$service")" != healthy ]; then
    echo "$service must be running and healthy. Start the databases with npm start." >&2
    exit 1
  fi
done

echo "Checking source schemas and destination connectivity..."
sql oracle-source "declare
  schema_count number;
begin
  select count(*) into schema_count from dba_users where username in ($schema_sql);
  if schema_count != 7 then raise_application_error(-20001, 'Missing source fixture schemas'); end if;
end;
/" >"$artifacts/preflight.log" 2>&1

directory_query="select directory_path from all_directories where directory_name = 'DATA_PUMP_DIR';"
sql oracle-source "$directory_query" >"$artifacts/source-directory.log" 2>&1
sql oracle-destination "$directory_query" >"$artifacts/destination-directory.log" 2>&1
# Remove SQL*Plus blank lines/padding without splitting paths containing spaces.
source_dir=$(sed '/^[[:space:]]*$/d; s/[[:space:]]*$//' "$artifacts/source-directory.log")
destination_dir=$(sed '/^[[:space:]]*$/d; s/[[:space:]]*$//' "$artifacts/destination-directory.log")
for service in oracle-source oracle-destination; do
  directory=$source_dir
  [ "$service" != oracle-destination ] || directory=$destination_dir
  if [[ "$directory" != /* || "$directory" == *$'\n'* ]]; then
    echo "Could not resolve DATA_PUMP_DIR for $service: $directory" >&2
    exit 1
  fi
  compose exec -T "$service" bash -c 'test -d "$1" && test -r "$1" && test -w "$1" && test -x "$1"' bash "$directory"
done

pump() {
  service=$1
  utility=$2
  shift 2
  compose exec -T "$service" bash -c '
    set -euo pipefail
    utility=$1
    shift
    printf '\''system/"%s"@//localhost:1521/FREEPDB1\n'\'' "$ORACLE_PWD" |
      "$ORACLE_HOME/bin/$utility" "$@"
  ' bash "$utility" "$@"
}

import_metadata() {
  pump oracle-destination impdp DIRECTORY=DATA_PUMP_DIR "DUMPFILE=$dumpfile" \
    "SCHEMAS=$schemas" CONTENT=METADATA_ONLY \
    TRANSFORM=SEGMENT_ATTRIBUTES:N TRANSFORM=SEGMENT_CREATION:N "$@"
}

echo "Exporting metadata from oracle-source/FREEPDB1..."
pump oracle-source expdp DIRECTORY=DATA_PUMP_DIR "DUMPFILE=$dumpfile" \
  "LOGFILE=$export_log" "SCHEMAS=$schemas" CONTENT=METADATA_ONLY \
  2>&1 | tee "$artifacts/export-client.log"

echo "Transferring the completed dump to oracle-destination..."
compose cp "oracle-source:$source_dir/$dumpfile" "$artifacts/$dumpfile"
compose cp "$artifacts/$dumpfile" "oracle-destination:$destination_dir/$dumpfile"
# Compose copies as root; match the Oracle process user before importing.
compose exec -T --user root oracle-destination bash -c \
  'set -e; chown oracle:oinstall "$1"; chmod 600 "$1"' bash "$destination_dir/$dumpfile"
compose exec -T oracle-destination test -r "$destination_dir/$dumpfile"

echo "Resetting destination schemas: $schemas"
echo "WARNING: DROP USER CASCADE removes all existing objects and data in these destination schemas."
sql oracle-destination "begin
  for item in (select column_value username from table(sys.odcivarchar2list(
    'LIMITED_READER','SCHEMA_READER','FINANCE','COMMERCE','CATALOG','IAM','INDEX_SCHEMA'
  ))) loop
    begin
      execute immediate 'DROP USER ' || dbms_assert.enquote_name(item.username, false) || ' CASCADE';
    exception when others then
      if sqlcode != -1918 then raise; end if;
    end;
  end loop;
end;
/" >"$artifacts/reset.log" 2>&1

echo "Importing metadata into oracle-destination/FREEPDB1..."
# Import tables before indexes so the cross-owner index privilege can be scoped
# to IAM.PERMISSIONS. Defer constraints too, preserving their original indexes.
import_metadata "LOGFILE=$import_log" EXCLUDE=INDEX,CONSTRAINT,REF_CONSTRAINT \
  2>&1 | tee "$artifacts/import-client.log"

existing_grant=$(sql oracle-destination "select count(*) from dba_tab_privs
  where owner='IAM' and table_name='PERMISSIONS' and grantee='INDEX_SCHEMA' and privilege='INDEX';")
existing_grant=$(printf '%s' "$existing_grant" | tr -d '[:space:]')
case "$existing_grant" in
  0)
    temporary_index_grant=1
    sql oracle-destination 'grant index on IAM.PERMISSIONS to INDEX_SCHEMA;' >"$artifacts/index-grant.log" 2>&1
    ;;
  1) ;; # Preserve a grant already present in the source metadata.
  *) echo "Could not check the cross-schema INDEX grant" >&2; exit 1 ;;
esac

echo "Importing indexes and constraints..."
import_metadata "LOGFILE=$indexes_log" INCLUDE=INDEX,CONSTRAINT,REF_CONSTRAINT \
  2>&1 | tee "$artifacts/indexes-client.log"

echo "Compiling imported schemas and checking package/view validity..."
sql oracle-destination "declare
  invalid_count number;
begin
  for item in (select column_value username from table(sys.odcivarchar2list($schema_sql))) loop
    dbms_utility.compile_schema(schema => item.username, compile_all => false);
  end loop;
  select count(*) into invalid_count from dba_objects
    where owner in ($schema_sql) and status = 'INVALID'
      and object_type in ('PACKAGE','PACKAGE BODY','VIEW');
  if invalid_count != 0 then
    raise_application_error(-20002, 'Imported packages or views remain invalid; inspect DBA_ERRORS');
  end if;
end;
/" >"$artifacts/compile.log" 2>&1
