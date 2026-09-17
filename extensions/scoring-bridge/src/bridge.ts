import { HOST_ORIGIN, LOG_PREFIX } from './config';
import { createToolCommands, DisarmReason } from './commands';
import { createRemovalCommands } from './removals';
import { createFocusCommands } from './focus';
import { toMetrics } from './measurements';
import type { OhifMeasurementLike } from './measurements';
import { createThrottledEmitter } from './throttle';
import type {
  MeasurementAddedEvent,
  MeasurementRemovedEvent,
  MeasurementUpdatedEvent,
  Metrics,
  ViewerReadyEvent,
} from './contract/messages';

type Unsubscribe = () => void;

export interface BridgeDeps {
  servicesManager: AppTypes.ServicesManager;
  commandsManager: AppTypes.CommandsManager;
}

export interface Bridge {
  dispose: Unsubscribe;
  getArmedRowId: () => string | null;
}

const VIEWER_VERSION = process.env.VERSION_NUMBER ?? 'unknown';

// Ten updates a second follow a drag without visible lag and cut a 60 fps drag six-fold.
const UPDATE_INTERVAL_MS = 100;

// About nine frames: past the render pass that settles cachedStats after mouse-up, yet quick
// enough that a corrected value reaches the form before the user looks at it.
const ADDED_CORRECTION_DELAY_MS = 150;

export const createBridge = ({ servicesManager, commandsManager }: BridgeDeps): Bridge => {
  const { measurementService, toolGroupService } = servicesManager.services;

  const disposers: Unsubscribe[] = [];

  // Assigned in the measurementService block, where the per-measurement state lives.
  let forgetMeasurement: (uid: string) => void = () => undefined;

  const removals = createRemovalCommands({
    servicesManager,
    forget: uid => forgetMeasurement(uid),
  });
  disposers.push(() => removals.dispose());

  const focus = createFocusCommands({ servicesManager });

  const toolCommands = createToolCommands({
    servicesManager,
    commandsManager,
    onRemoveMeasurement: removals.handleRemove,
    onFocusMeasurement: focus.handleFocus,
  });

  // A-8: needed because MEASUREMENT_REMOVED carries only the uid (MeasurementService.ts:686-689).
  const uidToRowId = new Map<string, string>();

  const postToHost = (
    message:
      | ViewerReadyEvent
      | MeasurementAddedEvent
      | MeasurementUpdatedEvent
      | MeasurementRemovedEvent
  ): boolean => {
    if (window.parent === window) {
      console.debug(`${LOG_PREFIX} not embedded in an iframe -> skip ${message.type}`);
      return false;
    }

    window.parent.postMessage(message, HOST_ORIGIN);
    return true;
  };

  // Q-2: only HOST_ORIGIN may command the viewer. Logged once, so a misconfigured origin is
  // diagnosable without flooding from browser extensions or HMR clients.
  let foreignOriginLogged = false;

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== HOST_ORIGIN) {
      if (!foreignOriginLogged) {
        foreignOriginLogged = true;
        console.debug(
          `${LOG_PREFIX} ignoring message from foreign origin ${event.origin}; expected ${HOST_ORIGIN}`
        );
      }
      return;
    }

    toolCommands.handleMessage(event.data);
  };

  window.addEventListener('message', onMessage);
  disposers.push(() => window.removeEventListener('message', onMessage));

  // P-4: measurementService, not raw cornerstone events, because it merges ANNOTATION_ADDED +
  // ANNOTATION_COMPLETED into one MEASUREMENT_ADDED (MeasurementService.ts:545-576).
  if (measurementService) {
    // Single ADDED per uid is an OHIF detail (MeasurementService.ts:572-574), not a contract; a
    // duplicate would double the total. uidToRowId cannot serve: unarmed uids never enter it.
    const reportedUids = new Set<string>();

    // No causedBy on UPDATED (A-10): no command calls measurementService.update(), the OHIF loop
    // point (MeasurementService.ts:365-386), so an update always comes from the user's drag.
    const lastSentMetrics = new Map<string, string>();

    const updateEmitter = createThrottledEmitter<{ toolName: string; metrics: Metrics }>(
      UPDATE_INTERVAL_MS,
      (uid, { toolName, metrics }) => {
        const event: MeasurementUpdatedEvent = {
          version: 1,
          type: 'MEASUREMENT_UPDATED',
          measurementUid: uid,
          toolName,
          metrics,
        };

        if (!postToHost(event)) {
          return;
        }

        lastSentMetrics.set(uid, JSON.stringify(metrics));
        console.debug(`${LOG_PREFIX} MEASUREMENT_UPDATED sent`, event);
      }
    );
    disposers.push(() => updateEmitter.dispose());

    // cornerstone fills cachedStats in a scheduled render pass while ADDED is broadcast
    // synchronously on mouse-up, so a fast release can report a value one render behind.
    const correctionTimers = new Set<ReturnType<typeof setTimeout>>();
    disposers.push(() => {
      correctionTimers.forEach(timer => clearTimeout(timer));
      correctionTimers.clear();
      lastSentMetrics.clear();
    });

    const scheduleAddedCorrection = (uid: string): void => {
      const timer = setTimeout(() => {
        correctionTimers.delete(timer);

        const fresh = measurementService.getMeasurement(uid) as OhifMeasurementLike | undefined;

        if (!fresh) {
          return;
        }

        const metrics = toMetrics(fresh, { quiet: true });

        if (!metrics || JSON.stringify(metrics) === lastSentMetrics.get(uid)) {
          return;
        }

        console.debug(`${LOG_PREFIX} correcting late cachedStats for ${uid}`);
        updateEmitter.push(uid, {
          toolName: typeof fresh.toolName === 'string' ? fresh.toolName : '',
          metrics,
        });
      }, ADDED_CORRECTION_DELAY_MS);

      correctionTimers.add(timer);
    };

    const onMeasurementAdded = ({ measurement }: { measurement: OhifMeasurementLike }): void => {
      const uid = measurement?.uid;

      if (typeof uid !== 'string' || uid.length === 0) {
        console.warn(`${LOG_PREFIX} MEASUREMENT_ADDED without a uid; ignored`, measurement);
        return;
      }

      if (reportedUids.has(uid)) {
        console.debug(`${LOG_PREFIX} MEASUREMENT_ADDED for ${uid} already handled; ignored`);
        return;
      }

      const metrics = toMetrics(measurement);

      if (!metrics) {
        // Arming stays in place so the user can simply draw again.
        console.warn(`${LOG_PREFIX} no metrics for measurement ${uid}; nothing sent to the host`);
        return;
      }

      // A-8: unarmed drawings are forwarded with rowId: null; the host decides what to do.
      const armed = toolCommands.getArmed();

      const event: MeasurementAddedEvent = {
        version: 1,
        type: 'MEASUREMENT_ADDED',
        rowId: armed?.rowId ?? null,
        measurementUid: uid,
        toolName: typeof measurement.toolName === 'string' ? measurement.toolName : '',
        metrics,
        causedBy: armed?.requestId,
      };

      if (!postToHost(event)) {
        return;
      }

      reportedUids.add(uid);
      lastSentMetrics.set(uid, JSON.stringify(metrics));

      if (event.rowId !== null) {
        uidToRowId.set(uid, event.rowId);
        scheduleAddedCorrection(uid);
      }

      console.debug(`${LOG_PREFIX} MEASUREMENT_ADDED sent`, event);

      // C-4.3.6: after posting, so a failing tool restore cannot swallow the event.
      if (armed) {
        toolCommands.disarm(DisarmReason.MeasurementReceived);
      }
    };

    const subscription = measurementService.subscribe(
      measurementService.EVENTS.MEASUREMENT_ADDED,
      onMeasurementAdded
    );
    disposers.push(() => subscription.unsubscribe());

    const onMeasurementUpdated = ({ measurement }: { measurement: OhifMeasurementLike }): void => {
      const uid = measurement?.uid;

      if (typeof uid !== 'string' || uid.length === 0) {
        return;
      }

      if (!uidToRowId.has(uid)) {
        return;
      }

      // Mid-drag frames can carry stats cornerstone has not recomputed yet; quiet, not a warning.
      const metrics = toMetrics(measurement, { quiet: true });

      if (!metrics) {
        return;
      }

      // Selecting an annotation also fires ANNOTATION_MODIFIED; dropped before the throttle so
      // the trailing emit carries a real change.
      if (JSON.stringify(metrics) === lastSentMetrics.get(uid)) {
        return;
      }

      updateEmitter.push(uid, {
        toolName: typeof measurement.toolName === 'string' ? measurement.toolName : '',
        metrics,
      });
    };

    const updateSubscription = measurementService.subscribe(
      measurementService.EVENTS.MEASUREMENT_UPDATED,
      onMeasurementUpdated
    );
    disposers.push(() => updateSubscription.unsubscribe());

    forgetMeasurement = (uid: string): void => {
      uidToRowId.delete(uid);
      reportedUids.delete(uid);
      lastSentMetrics.delete(uid);
      // Discard, not flush: a trailing UPDATED after REMOVED would resurrect the cleared row.
      updateEmitter.discard(uid);
    };

    // P-6 / A-10: the other end of the loop in removals.ts. `measurement` is the uid string, not
    // the object (MeasurementService.ts:686-689).
    const onMeasurementRemoved = ({ measurement }: { measurement: unknown }): void => {
      const uid = typeof measurement === 'string' ? measurement : undefined;

      if (uid === undefined || uid.length === 0) {
        console.warn(`${LOG_PREFIX} MEASUREMENT_REMOVED without a uid; ignored`, measurement);
        return;
      }

      const causedBy = removals.takeCause(uid);

      const event: MeasurementRemovedEvent = {
        version: 1,
        type: 'MEASUREMENT_REMOVED',
        measurementUid: uid,
        causedBy,
      };

      forgetMeasurement(uid);

      if (!postToHost(event)) {
        return;
      }

      console.debug(`${LOG_PREFIX} MEASUREMENT_REMOVED sent`, event);
    };

    const removedSubscription = measurementService.subscribe(
      measurementService.EVENTS.MEASUREMENT_REMOVED,
      onMeasurementRemoved
    );
    disposers.push(() => removedSubscription.unsubscribe());
  } else {
    console.warn(`${LOG_PREFIX} measurementService unavailable; measurements will not be seen`);
  }

  let readySent = false;

  const postViewerReady = (): void => {
    if (readySent) {
      return;
    }

    const message: ViewerReadyEvent = {
      version: 1,
      type: 'VIEWER_READY',
      viewerVersion: VIEWER_VERSION,
    };

    if (!postToHost(message)) {
      return;
    }

    readySent = true;
    console.debug(`${LOG_PREFIX} VIEWER_READY sent to`, HOST_ORIGIN);
  };

  // A-9: setToolActive silently no-ops until a viewport has a tool group
  // (commandsModule.ts:1050-1055), so readiness waits for VIEWPORT_ADDED.
  if (toolGroupService) {
    const subscription = toolGroupService.subscribe(
      toolGroupService.EVENTS.VIEWPORT_ADDED,
      postViewerReady
    );
    disposers.push(() => subscription.unsubscribe());
  } else {
    console.warn(`${LOG_PREFIX} toolGroupService unavailable; sending VIEWER_READY immediately`);
    postViewerReady();
  }

  return {
    getArmedRowId: toolCommands.getArmedRowId,
    dispose: () => {
      toolCommands.disarm(DisarmReason.BridgeDispose);

      while (disposers.length > 0) {
        const disposer = disposers.pop();
        try {
          disposer?.();
        } catch (error) {
          console.warn(`${LOG_PREFIX} disposer failed`, error);
        }
      }
      uidToRowId.clear();
      readySent = false;
    },
  };
};
