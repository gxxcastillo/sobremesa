import * as fs from 'fs';
import * as path from 'path';

/** Appends one JSON line to `logPath`, creating parent directories as needed. */
export function appendRunLog(
  logPath: string,
  entry: Record<string, unknown>,
): void {
  const fullEntry = { runAt: new Date().toISOString(), ...entry };
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(fullEntry) + '\n');
}
