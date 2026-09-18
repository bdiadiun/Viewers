import { LOG_PREFIX } from './config';
import { DisarmReason } from './commands';
import type { ArmedState } from './commands';
import { toGeometry } from './geometry';
import { toMetrics } from './measurements';
import type { OhifMeasurementLike } from './measurements';
import type { PostToHost } from './messaging';
import type { ReportedMeasurements } from './reportedMeasurements';
import type { MeasurementAddedEvent, MeasurementRemovedEvent, Metrics } from './contract/messages';

// About nine frames: past the render pass that settles cachedStats after mouse-up, yet quick
// enough that a corrected value reaches the form before the user looks at it.
const ADDED_CORRECTION_DELAY_MS = 150;

export interface MeasurementStreamDeps {
  servicesManager: AppTypes.ServicesManager;
  post: PostToHost;
  reported: ReportedMeasurements;
  getArmed: () => ArmedState | null;
  disarm: (reason: DisarmReason) => void;
  takeCause: (uid: string) => string | undefined;
}

export interface MeasurementStream {
  dispose: () => void;
}

interface MeasurementPayload {
  measurement: OhifMeasurementLike;
}

interface AddedCorrection {
  schedule: (uid: string) => void;
  dispose: () => void;
}

interface AddedCorrectionDeps {
  measurementService: AppTypes.MeasurementService;
  reported: ReportedMeasurements;
}

interface AddedEventParts {
  uid: string;
  toolName: string;
  metrics: Metrics;
  measurement: OhifMeasurementLike;
  armed: ArmedState | null;
}

const readUid = (measurement: OhifMeasurementLike | undefined): string | null => {
  const uid = measurement?.uid;
  return typeof uid === 'string' && uid.length > 0 ? uid : null;
};

const readToolName = (measurement: OhifMeasurementLike): string =>
  typeof measurement.toolName === 'string' ? measurement.toolName : '';

// A-8: unarmed drawings are forwarded with rowId: null; the host decides what to do.
const toAddedEvent = ({
  uid,
  toolName,
  metrics,
  measurement,
  armed,
}: AddedEventParts): MeasurementAddedEvent => ({
  version: 1,
  type: 'MEASUREMENT_ADDED',
  rowId: armed?.rowId ?? null,
  measurementUid: uid,
  toolName,
  metrics,
  causedBy: armed?.requestId,
  // A-14: carried so the form can persist enough to have the annotation rebuilt after a reload.
  geometry: toGeometry(measurement),
});

const createAddedCorrection = ({
  measurementService,
  reported,
}: AddedCorrectionDeps): AddedCorrection => {
  // cornerstone fills cachedStats in a scheduled render pass while ADDED is broadcast
  // synchronously on mouse-up, so a fast release can report a value one render behind.
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const correct = (uid: string): void => {
    const fresh = measurementService.getMeasurement(uid) as OhifMeasurementLike | undefined;

    if (!fresh) {
      return;
    }

    const metrics = toMetrics(fresh, { quiet: true });

    if (!metrics || reported.wasLastSent(uid, metrics)) {
      return;
    }

    console.debug(`${LOG_PREFIX} correcting late cachedStats for ${uid}`);
    const update = { toolName: readToolName(fresh), metrics, geometry: toGeometry(fresh) };
    reported.pushUpdate(uid, update);
  };

  return {
    schedule: (uid: string): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        correct(uid);
      }, ADDED_CORRECTION_DELAY_MS);

      timers.add(timer);
    },

    dispose: (): void => {
      timers.forEach(timer => clearTimeout(timer));
      timers.clear();
    },
  };
};

const createAddedHandler =
  ({ post, reported, getArmed, disarm }: MeasurementStreamDeps, correction: AddedCorrection) =>
  ({ measurement }: MeasurementPayload): void => {
    const uid = readUid(measurement);

    if (uid === null) {
      console.warn(`${LOG_PREFIX} MEASUREMENT_ADDED without a uid; ignored`, measurement);
      return;
    }

    if (reported.isReported(uid)) {
      console.debug(`${LOG_PREFIX} MEASUREMENT_ADDED for ${uid} already handled; ignored`);
      return;
    }

    const metrics = toMetrics(measurement);

    if (!metrics) {
      // Arming stays in place so the user can simply draw again.
      console.warn(`${LOG_PREFIX} no metrics for measurement ${uid}; nothing sent to the host`);
      return;
    }

    const armed = getArmed();
    const toolName = readToolName(measurement);
    const event = toAddedEvent({ uid, toolName, metrics, measurement, armed });

    if (!post(event)) {
      return;
    }

    reported.recordAdded(uid, event.rowId, metrics);

    if (event.rowId !== null) {
      correction.schedule(uid);
    }

    console.debug(`${LOG_PREFIX} MEASUREMENT_ADDED sent`, event);

    // C-4.3.6: after posting, so a failing tool restore cannot swallow the event.
    if (armed) {
      disarm(DisarmReason.MeasurementReceived);
    }
  };

const createUpdatedHandler =
  ({ reported }: MeasurementStreamDeps) =>
  ({ measurement }: MeasurementPayload): void => {
    const uid = readUid(measurement);

    if (uid === null || !reported.isBoundToRow(uid)) {
      return;
    }

    // Mid-drag frames can carry stats cornerstone has not recomputed yet; quiet, not a warning.
    const metrics = toMetrics(measurement, { quiet: true });

    if (!metrics) {
      return;
    }

    // Selecting an annotation also fires ANNOTATION_MODIFIED; dropped before the throttle so
    // the trailing emit carries a real change.
    if (reported.wasLastSent(uid, metrics)) {
      return;
    }

    const update = {
      toolName: readToolName(measurement),
      metrics,
      geometry: toGeometry(measurement),
    };
    reported.pushUpdate(uid, update);
  };

// P-6 / A-10: the other end of the loop in removals.ts. `measurement` is the uid string, not
// the object (MeasurementService.ts:686-689).
const createRemovedHandler =
  ({ post, reported, takeCause }: MeasurementStreamDeps) =>
  ({ measurement }: { measurement: unknown }): void => {
    const uid = typeof measurement === 'string' ? measurement : undefined;

    if (uid === undefined || uid.length === 0) {
      console.warn(`${LOG_PREFIX} MEASUREMENT_REMOVED without a uid; ignored`, measurement);
      return;
    }

    const causedBy = takeCause(uid);

    const event: MeasurementRemovedEvent = {
      version: 1,
      type: 'MEASUREMENT_REMOVED',
      measurementUid: uid,
      causedBy,
    };

    reported.forget(uid);

    if (!post(event)) {
      return;
    }

    console.debug(`${LOG_PREFIX} MEASUREMENT_REMOVED sent`, event);
  };

// P-4: measurementService, not raw cornerstone events, because it merges ANNOTATION_ADDED +
// ANNOTATION_COMPLETED into one MEASUREMENT_ADDED (MeasurementService.ts:545-576).
export const createMeasurementStream = (deps: MeasurementStreamDeps): MeasurementStream => {
  const { measurementService } = deps.servicesManager.services;

  if (!measurementService) {
    console.warn(`${LOG_PREFIX} measurementService unavailable; measurements will not be seen`);
    return { dispose: (): void => undefined };
  }

  const correction = createAddedCorrection({ measurementService, reported: deps.reported });

  const subscriptions = [
    measurementService.subscribe(
      measurementService.EVENTS.MEASUREMENT_ADDED,
      createAddedHandler(deps, correction)
    ),
    measurementService.subscribe(
      measurementService.EVENTS.MEASUREMENT_UPDATED,
      createUpdatedHandler(deps)
    ),
    measurementService.subscribe(
      measurementService.EVENTS.MEASUREMENT_REMOVED,
      createRemovedHandler(deps)
    ),
  ];

  return {
    dispose: (): void => {
      subscriptions.forEach(subscription => subscription.unsubscribe());
      correction.dispose();
    },
  };
};
