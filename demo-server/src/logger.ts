import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  level: LogLevel;
  message: string;
  requestId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;
  errorCode?: string;
  mode?: string;
  [key: string]: unknown;
}

export class JsonFileLogger {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  write(fields: LogFields): void {
    const line = {
      time: new Date().toISOString(),
      service: 'demo-server',
      requestId: fields.requestId ?? randomUUID().replaceAll('-', '').slice(0, 12),
      ...fields,
    };
    appendFileSync(this.filePath, `${JSON.stringify(line)}\n`, 'utf8');
  }
}
