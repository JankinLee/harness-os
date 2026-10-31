import type { AppRuntime } from './runtime.js';
import type { ScheduledTask } from '../core/schedule.js';
import {
  runScheduledTaskDirectly,
  type ScheduledTaskOutcome,
} from './scheduled-task-runner.js';

export async function dispatchScheduledTask(options: {
  runtime: AppRuntime;
  task: ScheduledTask;
  scheduledFor: string;
  defaultProductDeliveryMode: 'local' | 'lark-doc';
}): Promise<ScheduledTaskOutcome> {
  return runScheduledTaskDirectly(options);
}
