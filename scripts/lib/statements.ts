export const schemas = ['IAM', 'CATALOG', 'COMMERCE', 'FINANCE', 'INDEX_SCHEMA', 'SCHEMA_READER', 'LIMITED_READER'];
const schemaSql = schemas.map((schema) => `'${schema}'`).join(',');

export const preflight = `declare
  schema_count number;
begin
  select count(*) into schema_count from dba_users where username in (${schemaSql});
  if schema_count != 7 then raise_application_error(-20001, 'Missing source fixture schemas'); end if;
end;
/`;

export const reset = `begin
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
/`;

export const compile = `declare
  invalid_count number;
begin
  for item in (select column_value username from table(sys.odcivarchar2list(${schemaSql}))) loop
    dbms_utility.compile_schema(schema => item.username, compile_all => false);
  end loop;
  select count(*) into invalid_count from dba_objects
    where owner in (${schemaSql}) and status = 'INVALID'
      and object_type in ('PACKAGE','PACKAGE BODY','VIEW');
  if invalid_count != 0 then
    raise_application_error(-20002, 'Imported packages or views remain invalid; inspect DBA_ERRORS');
  end if;
end;
/`;
