#!/bin/bash
set -euo pipefail

# Startup scripts run for new and persisted databases. The completion sequence
# is created by the final seed statement, so it also detects interrupted runs.
seed_state=$(echo "whenever oserror exit failure
whenever sqlerror exit sql.sqlcode
set heading off feedback off pages 0
alter session set container = FREEPDB1;
select (select count(*) from dba_users
         where username in ('IAM','CATALOG','COMMERCE','FINANCE')) || ':' ||
       (select count(*) from dba_sequences
         where sequence_owner = 'IAM'
           and sequence_name = 'SOURCE_SEED_COMPLETE')
from dual;
exit" | "$ORACLE_HOME/bin/sqlplus" -s "/ as sysdba" | tr -d '[:space:]')

if [ "$seed_state" = "0:0" ]; then
  echo "No seed schemas found; seeding source database"
  "$ORACLE_HOME/bin/sqlplus" -s "/ as sysdba" \
    @/opt/oracle/scripts/custom/01-seed.sql
elif [ "$seed_state" = "4:1" ]; then
  echo "Source seed already present; skipping"
else
  echo "Incomplete source seed detected ($seed_state); rebuilding seed schemas"
  "$ORACLE_HOME/bin/sqlplus" -s "/ as sysdba" <<'SQL'
WHENEVER SQLERROR EXIT SQL.SQLCODE
ALTER SESSION SET CONTAINER = FREEPDB1;
BEGIN
  FOR schema_name IN (
    SELECT column_value AS username
    FROM TABLE(sys.odcivarchar2list('LIMITED_READER', 'SCHEMA_READER', 'INDEX_SCHEMA', 'FINANCE', 'COMMERCE', 'CATALOG', 'IAM'))
  ) LOOP
    BEGIN
      EXECUTE IMMEDIATE 'DROP USER ' || schema_name.username || ' CASCADE';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLCODE != -1918 THEN
          RAISE;
        END IF;
    END;
  END LOOP;
END;
/
SQL
  "$ORACLE_HOME/bin/sqlplus" -s "/ as sysdba" \
    @/opt/oracle/scripts/custom/01-seed.sql
fi
