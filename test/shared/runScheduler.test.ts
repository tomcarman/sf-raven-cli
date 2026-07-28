import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunScheduler } from '../../src/shared/runScheduler.js';

const debounceMs = 20;

type Recorder = {
  run: () => Promise<void>;
  calls: number;
  finish: () => void;
};

/** A run function that stays in flight until `finish` is called. */
const gatedRun = (): Recorder => {
  const recorder: Recorder = {
    calls: 0,
    finish: () => {},
    run: () =>
      new Promise<void>((resolveRun) => {
        recorder.calls++;
        recorder.finish = resolveRun;
      }),
  };

  return recorder;
};

describe('run scheduler', () => {
  it('runs immediately on runNow without waiting for the debounce', async () => {
    let calls = 0;
    const scheduler = createRunScheduler(async () => {
      calls++;
    }, debounceMs);

    scheduler.runNow();

    assert.equal(calls, 1);
    scheduler.stop();
  });

  it('collapses a burst of triggers into one run', async () => {
    let calls = 0;
    const scheduler = createRunScheduler(async () => {
      calls++;
    }, debounceMs);

    scheduler.trigger();
    scheduler.trigger();
    scheduler.trigger();

    assert.equal(calls, 0, 'nothing runs until the burst settles');

    await delay(debounceMs * 3);

    assert.equal(calls, 1);
    scheduler.stop();
  });

  it('coalesces changes that land mid-run into a single trailing rerun', async () => {
    const recorder = gatedRun();
    const scheduler = createRunScheduler(recorder.run, debounceMs);

    scheduler.runNow();
    assert.equal(recorder.calls, 1);

    // Three saves while the first run is still in flight.
    scheduler.trigger();
    await delay(debounceMs * 2);
    scheduler.trigger();
    await delay(debounceMs * 2);
    scheduler.trigger();
    await delay(debounceMs * 2);

    assert.equal(recorder.calls, 1, 'no run starts while one is in flight');

    recorder.finish();
    await delay(debounceMs);

    assert.equal(recorder.calls, 2, 'exactly one trailing rerun');

    recorder.finish();
    await delay(debounceMs * 2);

    assert.equal(recorder.calls, 2, 'the trailing rerun is not repeated');
    scheduler.stop();
  });

  it('keeps running after the loop settles', async () => {
    let calls = 0;
    const scheduler = createRunScheduler(async () => {
      calls++;
    }, debounceMs);

    scheduler.runNow();
    await delay(debounceMs);
    scheduler.trigger();
    await delay(debounceMs * 3);

    assert.equal(calls, 2);
    scheduler.stop();
  });

  it('cancels a pending run on stop', async () => {
    let calls = 0;
    const scheduler = createRunScheduler(async () => {
      calls++;
    }, debounceMs);

    scheduler.trigger();
    scheduler.stop();

    await delay(debounceMs * 3);

    assert.equal(calls, 0);
  });

  it('drops a queued trailing rerun on stop', async () => {
    const recorder = gatedRun();
    const scheduler = createRunScheduler(recorder.run, debounceMs);

    scheduler.runNow();
    scheduler.trigger();
    await delay(debounceMs * 2);

    scheduler.stop();
    recorder.finish();
    await delay(debounceMs * 2);

    assert.equal(recorder.calls, 1);
  });

  it('keeps looping when a run rejects', async () => {
    let calls = 0;
    const scheduler = createRunScheduler(async () => {
      calls++;
      throw new Error('boom');
    }, debounceMs);

    scheduler.runNow();
    await delay(debounceMs);
    scheduler.trigger();
    await delay(debounceMs * 3);

    assert.equal(calls, 2);
    scheduler.stop();
  });
});
