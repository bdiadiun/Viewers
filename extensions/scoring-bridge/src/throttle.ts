/**
 * A per-key leading+trailing throttle (S-5.1, Q-5).
 *
 * `MEASUREMENT_UPDATED` fires once per `ANNOTATION_MODIFIED`, i.e. once per drag frame
 * (extensions/cornerstone/src/initMeasurementService.ts:262-284, :340), so a 600 ms drag produces
 * dozens of events. Posting all of them across the iframe boundary would make the host re-render
 * per frame for no information gain: only the latest value of a drag is meaningful.
 *
 * Contract:
 * - the first `push` for a key emits immediately (the host sees the drag start without lag);
 * - further pushes inside the interval are collapsed to the latest value, which is emitted by a
 *   trailing timer — so the value the user released the handle on is always delivered, and is
 *   always the last thing the host receives for that key;
 * - `dispose` drops pending values and timers; nothing is emitted after it.
 *
 * Why per key and not one global throttle: several annotations can be edited in sequence (or a
 * post-ADDED correction can land while another annotation is being dragged), and a global throttle
 * would let one annotation's drag swallow another annotation's final value. Keys are independent
 * streams; each gets its own budget and its own trailing emit.
 *
 * No dependencies on OHIF or on the contract — this file is pure timing logic.
 */

export interface ThrottledEmitter<T> {
  /** Offers `value` as the newest state of `key`; emits now or on the trailing timer. */
  push(key: string, value: T): void;
  /** Emits the pending value of `key` (or of every key when omitted) right away. */
  flush(key?: string): void;
  /**
   * Forgets `key` without emitting: its pending value and its trailing timer are dropped.
   * Used when the measurement behind the key ceases to exist (S-5.2): a trailing
   * MEASUREMENT_UPDATED for an annotation the host has just removed would resurrect a deleted row.
   */
  discard(key: string): void;
  /** Q-5: cancels every timer and drops every pending value. */
  dispose(): void;
}

interface KeyState<T> {
  /** Timestamp of the last emit for this key, or null when nothing was emitted yet. */
  lastEmitAt: number | null;
  /** Timer that will emit `pending`, or null when no emit is scheduled. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Latest value offered since the last emit; `has` distinguishes "none" from a falsy value. */
  pending: { value: T } | null;
}

export function createThrottledEmitter<T>(
  intervalMs: number,
  emit: (key: string, value: T) => void
): ThrottledEmitter<T> {
  const states = new Map<string, KeyState<T>>();
  let disposed = false;

  const emitNow = (key: string, state: KeyState<T>, value: T): void => {
    state.lastEmitAt = Date.now();
    state.pending = null;
    emit(key, value);
  };

  const fire = (key: string, state: KeyState<T>): void => {
    state.timer = null;

    const pending = state.pending;

    if (pending) {
      emitNow(key, state, pending.value);
    }
  };

  return {
    push(key: string, value: T): void {
      if (disposed) {
        return;
      }

      let state = states.get(key);

      if (!state) {
        state = { lastEmitAt: null, timer: null, pending: null };
        states.set(key, state);
      }

      state.pending = { value };

      if (state.timer !== null) {
        // A trailing emit is already scheduled; it will pick up the value just stored.
        return;
      }

      const elapsed = state.lastEmitAt === null ? Infinity : Date.now() - state.lastEmitAt;

      if (elapsed >= intervalMs) {
        emitNow(key, state, value);
        return;
      }

      const wait = intervalMs - elapsed;
      const scheduled = state;
      scheduled.timer = setTimeout(() => fire(key, scheduled), wait);
    },

    flush(key?: string): void {
      if (disposed) {
        return;
      }

      const keys = key === undefined ? Array.from(states.keys()) : [key];

      for (const k of keys) {
        const state = states.get(k);

        if (!state) {
          continue;
        }

        if (state.timer !== null) {
          clearTimeout(state.timer);
          state.timer = null;
        }

        const pending = state.pending;

        if (pending) {
          emitNow(k, state, pending.value);
        }
      }
    },

    discard(key: string): void {
      const state = states.get(key);

      if (!state) {
        return;
      }

      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }

      state.pending = null;
      states.delete(key);
    },

    dispose(): void {
      disposed = true;

      for (const state of states.values()) {
        if (state.timer !== null) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        state.pending = null;
      }

      states.clear();
    },
  };
}
