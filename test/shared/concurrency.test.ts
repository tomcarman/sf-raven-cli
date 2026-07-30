import assert from 'node:assert/strict';
import { mapWithConcurrency } from '../../src/shared/concurrency.js';

describe('mapWithConcurrency', () => {
  it('returns results in input order', async () => {
    const results = await mapWithConcurrency([3, 1, 2], 2, async (value) => value * 2);

    assert.deepEqual(results, [6, 2, 4]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      5,
      async (value) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((done) => setTimeout(done, 1));
        inFlight--;

        return value;
      }
    );

    assert.equal(peak <= 5, true, `peak was ${peak}`);
  });

  it('handles an empty input', async () => {
    assert.deepEqual(await mapWithConcurrency([], 5, async (value) => value), []);
  });
});
