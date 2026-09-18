// Leading + trailing, so the value a handle is released on is always the last one emitted.
// Per key, so one annotation's drag cannot swallow another annotation's final value.

export interface ThrottledEmitter<T> {
  push: (key: string, value: T) => void;
  flush: (key?: string) => void;
  discard: (key: string) => void;
  dispose: () => void;
}

type Emit<T> = (key: string, value: T) => void;

interface KeyState<T> {
  lastEmitAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  // Wrapped so a falsy value is distinguishable from "nothing pending".
  pending: { value: T } | null;
}

interface EmitterState<T> {
  keys: Map<string, KeyState<T>>;
  intervalMs: number;
  emit: Emit<T>;
}

const stopTimer = <T>(state: KeyState<T>): void => {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
};

const emitNow = <T>(key: string, state: KeyState<T>, value: T, emit: Emit<T>): void => {
  state.lastEmitAt = Date.now();
  state.pending = null;
  emit(key, value);
};

const emitPending = <T>(key: string, state: KeyState<T>, emit: Emit<T>): void => {
  const pending = state.pending;

  if (pending) {
    emitNow(key, state, pending.value, emit);
  }
};

const pushValue = <T>({ keys, intervalMs, emit }: EmitterState<T>, key: string, value: T): void => {
  let state = keys.get(key);

  if (!state) {
    state = { lastEmitAt: null, timer: null, pending: null };
    keys.set(key, state);
  }

  state.pending = { value };

  if (state.timer !== null) {
    return;
  }

  const elapsed = state.lastEmitAt === null ? Infinity : Date.now() - state.lastEmitAt;

  if (elapsed >= intervalMs) {
    emitNow(key, state, value, emit);
    return;
  }

  const scheduled = state;
  scheduled.timer = setTimeout(() => {
    scheduled.timer = null;
    emitPending(key, scheduled, emit);
  }, intervalMs - elapsed);
};

export const createThrottledEmitter = <T>(
  intervalMs: number,
  emit: Emit<T>
): ThrottledEmitter<T> => {
  const state: EmitterState<T> = { keys: new Map<string, KeyState<T>>(), intervalMs, emit };
  let disposed = false;

  return {
    push: (key: string, value: T): void => {
      if (disposed) {
        return;
      }

      pushValue(state, key, value);
    },

    flush: (key?: string): void => {
      if (disposed) {
        return;
      }

      const keys = key === undefined ? Array.from(state.keys.keys()) : [key];

      for (const k of keys) {
        const keyState = state.keys.get(k);

        if (!keyState) {
          continue;
        }

        stopTimer(keyState);
        emitPending(k, keyState, emit);
      }
    },

    discard: (key: string): void => {
      const keyState = state.keys.get(key);

      if (!keyState) {
        return;
      }

      stopTimer(keyState);
      keyState.pending = null;
      state.keys.delete(key);
    },

    dispose: (): void => {
      disposed = true;

      for (const keyState of state.keys.values()) {
        stopTimer(keyState);
        keyState.pending = null;
      }

      state.keys.clear();
    },
  };
};
