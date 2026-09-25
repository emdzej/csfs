/**
 * One piece of work, several readers, each able to give up.
 *
 * A backend shares expensive work between concurrent readers — one download
 * of a file that several slices want, one inflation of an entry that several
 * reads want. Cancelling that work because *one* reader lost interest would
 * fail the others, and never cancelling it would keep a 945 MB download going
 * after everyone who wanted it has left. So it is cancelled when the last
 * reader holding a signal aborts, and never while a reader without one is
 * waiting.
 */

/** Settle with the promise, or reject with the signal's reason, whichever is first. */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Wrap work so that concurrent callers share one run of it.
 *
 * A success is kept, so later callers get it at once. A failure is not, and
 * neither is a run abandoned by every caller: the next call starts again.
 */
export function shared<T>(
  start: (signal: AbortSignal) => Promise<T>,
): (signal?: AbortSignal) => Promise<T> {
  interface Run {
    readonly promise: Promise<T>;
    readonly controller: AbortController;
    /** Callers with a signal still waiting. */
    waiting: number;
    /** A caller without a signal joined, so nothing may cancel it. */
    pinned: boolean;
    settled: boolean;
  }
  let run: Run | undefined;

  const begin = (): Run => {
    const controller = new AbortController();
    const r: Run = {
      promise: start(controller.signal),
      controller,
      waiting: 0,
      pinned: false,
      settled: false,
    };
    r.promise.then(
      () => {
        r.settled = true;
      },
      () => {
        r.settled = true;
        if (run === r) run = undefined;
      },
    );
    return r;
  };

  return (signal) => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const r = (run ??= begin());
    if (!signal) {
      r.pinned = true;
      return r.promise;
    }
    r.waiting += 1;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        reject(signal.reason);
        r.waiting -= 1;
        if (r.waiting === 0 && !r.pinned && !r.settled) {
          r.controller.abort(signal.reason);
          if (run === r) run = undefined;
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      r.promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };
}
