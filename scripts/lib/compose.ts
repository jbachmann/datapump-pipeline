import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export interface CommandOptions {
  input?: string;
  log?: string;
  append?: boolean;
  stream?: boolean;
  inherit?: boolean;
}

export class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// Argument arrays avoid host-shell interpolation. Credentials stay in containers.
export function compose(args: string[], options: CommandOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const log = options.log ? openSync(options.log, options.append ? 'a' : 'w', 0o600) : undefined;
    const child = spawn('docker', [
      'compose', '--env-file', `${projectRoot}.env`,
      '--project-name', 'datapump-pipeline-test',
      '--file', `${projectRoot}docker-compose.yml`, ...args,
    ], { stdio: options.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderrOutput = '';
    let interrupted: NodeJS.Signals | undefined;
    let failure: Error | undefined;
    const interrupt = (signal: NodeJS.Signals) => {
      interrupted = signal;
      child.kill(signal);
    };
    const onInt = () => interrupt('SIGINT');
    const onTerm = () => interrupt('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const output = (data: Buffer, stderr: boolean) => {
      if (!stderr && !options.stream) stdout += data.toString();
      if (stderr && !options.log) stderrOutput += data.toString();
      try {
        if (log !== undefined) writeSync(log, data);
        if (options.stream) (stderr ? process.stderr : process.stdout).write(data);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        child.kill('SIGTERM');
      }
    };
    child.stdout?.on('data', (data: Buffer) => output(data, false));
    child.stderr?.on('data', (data: Buffer) => output(data, true));
    child.on('error', (error) => { failure = error; });
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') failure = error;
    });
    child.stdin?.end(options.input ?? '');
    child.on('close', (code, signal) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      if (log !== undefined) closeSync(log);
      const stopped = interrupted ?? signal;
      const exitCode = stopped === 'SIGINT' ? 130 : stopped ? 143 : (code ?? 1);
      if (failure) reject(failure);
      else if (exitCode !== 0) reject(new CommandError(`Docker Compose ${args[0]} failed (exit ${exitCode})${options.log ? `; see ${options.log}` : `: ${stderrOutput.trim()}`}`, exitCode));
      else resolve(stdout);
    });
  });
}

export function reportError(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof CommandError ? error.exitCode : 1;
}
