// Leading + trailing, so the value a handle is released on is always the last one emitted.
// Per key, so one annotation's drag cannot swallow another annotation's final value.

export interface ThrottledEmitter<T> {
  push: (key: string, value: T) => void;
  flush: (key?: string) => void;
  discard: (key: string) => void;
  dispose: () => void;
}

interface KeyState<T> {
  lastEmitAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  // Wrapped so a falsy value is distinguishable from "nothing pending".
  pending: { value: T } | null;
}

export const createThrottledEmitter = <T>(
  intervalMs: number,
  emit: (key: string, value: T) => void
): ThrottledEmitter<T> => {
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
    push: (key: string, value: T): void => {
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

    flush: (key?: string): void => {
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

    discard: (key: string): void => {
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

    dispose: (): void => {
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
};
