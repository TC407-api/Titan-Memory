/**
 * Background Scheduler
 * Runs consolidation, pruning, and backup on configurable intervals.
 * Mutex prevents concurrent runs. EventEmitter for observability.
 */

import { EventEmitter } from 'events';

export interface SchedulerTasks {
  consolidate: () => Promise<unknown>;
  prune: () => Promise<unknown>;
  backup?: () => Promise<unknown>;
}

export interface SchedulerConfig {
  consolidateIntervalMs: number;
  pruneIntervalMs: number;
  backupIntervalMs?: number;
}

export class BackgroundScheduler extends EventEmitter {
  private tasks: SchedulerTasks;
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private locked = false;

  constructor(tasks: SchedulerTasks) {
    super();
    this.tasks = tasks;
    // Prevent Node from throwing on unhandled 'error' events
    this.on('error', () => {});
  }

  start(config: SchedulerConfig): void {
    if (this.running) return;
    this.running = true;

    this.timers.push(
      setInterval(() => this.runTask('consolidate', this.tasks.consolidate), config.consolidateIntervalMs),
    );

    this.timers.push(
      setInterval(() => this.runTask('prune', this.tasks.prune), config.pruneIntervalMs),
    );

    if (this.tasks.backup && config.backupIntervalMs) {
      this.timers.push(
        setInterval(() => this.runTask('backup', this.tasks.backup!), config.backupIntervalMs),
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    // Wait for any in-flight task to finish
    while (this.locked) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private async runTask(name: string, task: () => Promise<unknown>): Promise<void> {
    if (this.locked) return; // Skip if another task is running
    this.locked = true;
    try {
      const result = await task();
      this.emit(`${name === 'consolidate' ? 'consolidation' : name}-complete`, result);
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.locked = false;
    }
  }
}
