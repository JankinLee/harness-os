import type { CliId } from '../cli/types.js';

export type SlashCommand =
  | { name: 'close' | 'status' | 'help' | 'new' | 'resume' | 'team' }
  | { name: 'compact'; instructions?: string }
  | { name: 'cd'; path?: string }
  | { name: 'mount'; path?: string }
  | { name: 'workspace'; path?: string }
  | { name: 'schedules' }
  | { name: 'archive' }
  | { name: 'governance' }
  | { name: 'schedule'; request?: string };

const COMMAND_RE =
  /^(?:@.+?\s+)?\/(close|status|help|new|resume|team|archive|governance)\s*$/;
const CD_RE = /^(?:@.+?\s+)?\/cd(?:\s+([\s\S]+?))?\s*$/;
const MOUNT_RE = /^(?:@.+?\s+)?\/mount(?:\s+([\s\S]+?))?\s*$/;
const WORKSPACE_RE = /^(?:@.+?\s+)?\/workspace(?:\s+([\s\S]+?))?\s*$/;
const COMPACT_RE = /^(?:@.+?\s+)?\/compact(?:\s+([\s\S]+?))?\s*$/;
const SCHEDULE_RE = /^(?:@.+?\s+)?\/schedule(?:\s+([\s\S]+?))?\s*$/;
const SCHEDULES_RE = /^(?:@.+?\s+)?\/schedules\s*$/;
const CLI_REQUEST_RE = /^(?:@.+?\s+)?(?:\/(claude|codex)(?:\s+([\s\S]*))?|\/(?:use|engine)\s+(claude|codex)(?:\s+([\s\S]*))?)$/;

export function parseCommand(text: string): SlashCommand | undefined {
  const value = text.trim();
  if (SCHEDULES_RE.test(value)) return { name: 'schedules' };
  const scheduleMatch = SCHEDULE_RE.exec(value);
  if (scheduleMatch) {
    return { name: 'schedule', request: scheduleMatch[1]?.trim() || undefined };
  }
  const mountMatch = MOUNT_RE.exec(value);
  if (mountMatch) {
    return { name: 'mount', path: mountMatch[1]?.trim() || undefined };
  }
  const wsMatch = WORKSPACE_RE.exec(value);
  if (wsMatch) {
    return { name: 'workspace', path: wsMatch[1]?.trim() || undefined };
  }
  const cdMatch = CD_RE.exec(value);
  if (cdMatch) return { name: 'cd', path: cdMatch[1]?.trim() || undefined };
  const compactMatch = COMPACT_RE.exec(value);
  if (compactMatch) {
    return {
      name: 'compact',
      instructions: compactMatch[1]?.trim() || undefined,
    };
  }
  const match = COMMAND_RE.exec(value);
  if (!match) return undefined;
  return {
    name: match[1] as
      | 'close'
      | 'status'
      | 'help'
      | 'new'
      | 'resume'
      | 'team'
      | 'archive'
      | 'governance',
  };
}

export interface CliRequest {
  cliId: CliId;
  prompt: string;
}

export function parseCliRequest(text: string): CliRequest | undefined {
  const match = CLI_REQUEST_RE.exec(text.trim());
  if (!match) return undefined;
  return {
    cliId: (match[1] || match[3]) as CliId,
    prompt: (match[2] || match[4] || '').trim(),
  };
}
