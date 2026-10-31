export type FaultMode =
  | 'none'
  | 'slow'
  | 'error-spike'
  | 'repeated-error'
  | 'db-down';

const FAULT_MODES: FaultMode[] = [
  'none',
  'slow',
  'error-spike',
  'repeated-error',
  'db-down',
];

export class FaultStore {
  private mode: FaultMode = 'none';

  get(): FaultMode {
    return this.mode;
  }

  set(mode: unknown): FaultMode {
    if (typeof mode !== 'string' || !FAULT_MODES.includes(mode as FaultMode)) {
      throw new Error(`未知故障模式: ${String(mode)}`);
    }
    this.mode = mode as FaultMode;
    return this.mode;
  }

  reset(): FaultMode {
    this.mode = 'none';
    return this.mode;
  }
}
