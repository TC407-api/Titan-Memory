/**
 * Background Scheduler Tests (Phase 1 — TDD RED)
 */

import { BackgroundScheduler } from '../src/adaptive/background-scheduler';

describe('BackgroundScheduler', () => {
  let scheduler: BackgroundScheduler;

  afterEach(async () => {
    if (scheduler?.isRunning()) {
      await scheduler.stop();
    }
  });

  it('should start and stop cleanly', async () => {
    const tasks = { consolidate: jest.fn().mockResolvedValue(undefined), prune: jest.fn().mockResolvedValue(undefined) };
    scheduler = new BackgroundScheduler(tasks);

    scheduler.start({ consolidateIntervalMs: 60000, pruneIntervalMs: 120000 });
    expect(scheduler.isRunning()).toBe(true);

    await scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it('should run consolidation task on interval', async () => {
    const consolidate = jest.fn().mockResolvedValue({ consolidated: 2 });
    const prune = jest.fn().mockResolvedValue({ pruned: 0 });
    scheduler = new BackgroundScheduler({ consolidate, prune });

    scheduler.start({ consolidateIntervalMs: 50, pruneIntervalMs: 999999 });

    await new Promise(resolve => setTimeout(resolve, 150));
    await scheduler.stop();

    expect(consolidate).toHaveBeenCalled();
  });

  it('should run prune task on interval', async () => {
    const consolidate = jest.fn().mockResolvedValue({ consolidated: 0 });
    const prune = jest.fn().mockResolvedValue({ pruned: 3 });
    scheduler = new BackgroundScheduler({ consolidate, prune });

    scheduler.start({ consolidateIntervalMs: 999999, pruneIntervalMs: 50 });

    await new Promise(resolve => setTimeout(resolve, 150));
    await scheduler.stop();

    expect(prune).toHaveBeenCalled();
  });

  it('should prevent concurrent runs with mutex', async () => {
    let running = 0;
    let maxConcurrent = 0;
    const slowTask = jest.fn().mockImplementation(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise(resolve => setTimeout(resolve, 80));
      running--;
    });

    scheduler = new BackgroundScheduler({ consolidate: slowTask, prune: jest.fn().mockResolvedValue(undefined) });
    scheduler.start({ consolidateIntervalMs: 20, pruneIntervalMs: 999999 });

    await new Promise(resolve => setTimeout(resolve, 250));
    await scheduler.stop();

    expect(maxConcurrent).toBe(1);
  });

  it('should not crash on task error', async () => {
    const failingTask = jest.fn().mockRejectedValue(new Error('consolidation failed'));
    const prune = jest.fn().mockResolvedValue({ pruned: 0 });
    scheduler = new BackgroundScheduler({ consolidate: failingTask, prune });

    scheduler.start({ consolidateIntervalMs: 50, pruneIntervalMs: 999999 });

    await new Promise(resolve => setTimeout(resolve, 150));
    await scheduler.stop();

    // Scheduler should still be functional — it stopped cleanly
    expect(scheduler.isRunning()).toBe(false);
    expect(failingTask).toHaveBeenCalled();
  });

  it('should emit events on task completion', async () => {
    const consolidate = jest.fn().mockResolvedValue({ consolidated: 5 });
    const prune = jest.fn().mockResolvedValue({ pruned: 2 });
    scheduler = new BackgroundScheduler({ consolidate, prune });

    const events: string[] = [];
    scheduler.on('consolidation-complete', () => events.push('consolidation'));
    scheduler.on('prune-complete', () => events.push('prune'));

    scheduler.start({ consolidateIntervalMs: 50, pruneIntervalMs: 50 });

    await new Promise(resolve => setTimeout(resolve, 150));
    await scheduler.stop();

    expect(events).toContain('consolidation');
    expect(events).toContain('prune');
  });

  it('should emit error event on task failure', async () => {
    const failingTask = jest.fn().mockRejectedValue(new Error('boom'));
    scheduler = new BackgroundScheduler({ consolidate: failingTask, prune: jest.fn().mockResolvedValue(undefined) });

    const errors: Error[] = [];
    scheduler.on('error', (err: Error) => errors.push(err));

    scheduler.start({ consolidateIntervalMs: 50, pruneIntervalMs: 999999 });

    await new Promise(resolve => setTimeout(resolve, 150));
    await scheduler.stop();

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toBe('boom');
  });

  it('should not start if already running', () => {
    scheduler = new BackgroundScheduler({
      consolidate: jest.fn().mockResolvedValue(undefined),
      prune: jest.fn().mockResolvedValue(undefined),
    });

    scheduler.start({ consolidateIntervalMs: 60000, pruneIntervalMs: 120000 });
    expect(() => scheduler.start({ consolidateIntervalMs: 60000, pruneIntervalMs: 120000 })).not.toThrow();
    expect(scheduler.isRunning()).toBe(true);
  });

  it('should handle stop when not running', async () => {
    scheduler = new BackgroundScheduler({
      consolidate: jest.fn().mockResolvedValue(undefined),
      prune: jest.fn().mockResolvedValue(undefined),
    });

    await expect(scheduler.stop()).resolves.not.toThrow();
  });

  it('should run backup task if provided', async () => {
    const backup = jest.fn().mockResolvedValue({ memoryCount: 100 });
    scheduler = new BackgroundScheduler({
      consolidate: jest.fn().mockResolvedValue(undefined),
      prune: jest.fn().mockResolvedValue(undefined),
      backup,
    });

    scheduler.start({ consolidateIntervalMs: 999999, pruneIntervalMs: 999999, backupIntervalMs: 50 });

    await new Promise(resolve => setTimeout(resolve, 150));
    await scheduler.stop();

    expect(backup).toHaveBeenCalled();
  });
});
