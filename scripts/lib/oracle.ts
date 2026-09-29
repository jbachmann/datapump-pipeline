import { compose, type CommandOptions } from './compose.ts';

export type Service = 'oracle-source' | 'oracle-destination';

export function sql(service: Service, statement: string, options: CommandOptions = {}): Promise<string> {
  return compose(['exec', '-T', service, 'bash', '-c', String.raw`
    set -euo pipefail
    case "$ORACLE_PWD" in
      *\"*|*$'\n'*|*$'\r'*) echo "Unsupported password characters" >&2; exit 1 ;;
    esac
    {
      printf "%s\n" "whenever oserror exit failure" "whenever sqlerror exit failure" "set define off echo off"
      printf 'connect system/"%s"@localhost:1521/FREEPDB1\n' "$ORACLE_PWD"
      cat
    } | "$ORACLE_HOME/bin/sqlplus" -L -s /nolog`], {
    ...options,
    input: `whenever oserror exit failure
whenever sqlerror exit failure
set heading off feedback off pages 0 verify off echo off lines 32767 trimspool on
${statement}
exit
`,
  });
}

export function pump(service: Service, utility: 'expdp' | 'impdp', args: string[], log: string): Promise<string> {
  return compose(['exec', '-T', service, 'bash', '-c', String.raw`
    set -euo pipefail
    utility=$1
    shift
    printf 'system/"%s"@//localhost:1521/FREEPDB1\n' "$ORACLE_PWD" |
      "$ORACLE_HOME/bin/$utility" "$@"`, 'bash', utility, ...args], { log, stream: true });
}
