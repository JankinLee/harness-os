export interface ActiveRun {
  controller: AbortController;
  ownerOpenId: string;
  cancelMode?: 'stop' | 'close';
}

export type AbortTaskOutcome =
  | 'stopped'
  | 'already_stopping'
  | 'not_found'
  | 'forbidden';

export function requestTaskAbort(
  activeRuns: Map<string, ActiveRun>,
  sessionId: string,
  operatorOpenId: string,
  adminOpenIds?: Iterable<string>,
): AbortTaskOutcome {
  const active = activeRuns.get(sessionId);
  if (!active) return 'not_found';
  if (!operatorOpenId) return 'forbidden';

  const admins = new Set(adminOpenIds ?? []);
  const envOwner = process.env.OWNER_OPEN_ID;
  if (envOwner) admins.add(envOwner);

  const isOwner = active.ownerOpenId === operatorOpenId;
  const isAdmin = admins.has(operatorOpenId);
  if (!isOwner && !isAdmin) return 'forbidden';
  if (active.controller.signal.aborted) return 'already_stopping';
  active.cancelMode = 'stop';
  active.controller.abort();
  return 'stopped';
}
