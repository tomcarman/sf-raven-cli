export type RunScheduler = {
  /** Runs immediately, skipping the debounce (used for the first run on start). */
  runNow: () => void;
  /** Requests a run once the file system settles. */
  trigger: () => void;
  /** Cancels any pending run. In-flight runs are left to finish. */
  stop: () => void;
};

/**
 * Turns a stream of file-change notifications into a well-behaved run loop:
 * bursts are debounced into one run, and changes that land while a run is in
 * flight coalesce into a single trailing rerun rather than queueing up.
 */
export const createRunScheduler = (run: () => Promise<void>, debounceMs = 200): RunScheduler => {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;

  const start = (): void => {
    running = true;

    void run().finally(() => {
      running = false;

      if (pending) {
        pending = false;
        start();
      }
    });
  };

  const fire = (): void => {
    timer = undefined;

    if (running) {
      pending = true;
      return;
    }

    start();
  };

  const cancelTimer = (): void => {
    if (timer != null) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    runNow: (): void => {
      cancelTimer();
      fire();
    },
    trigger: (): void => {
      cancelTimer();
      timer = setTimeout(fire, debounceMs);
    },
    stop: (): void => {
      cancelTimer();
      pending = false;
    },
  };
};
