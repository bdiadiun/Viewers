import { LOG_PREFIX } from './config';
import { createThrottledEmitter } from './throttle';
import type { PostToHost } from './messaging';
import type { MeasurementGeometry, MeasurementUpdatedEvent, Metrics } from './contract/messages';

// Ten updates a second follow a drag without visible lag and cut a 60 fps drag six-fold.
const UPDATE_INTERVAL_MS = 100;

export interface MeasurementUpdate {
  toolName: string;
  metrics: Metrics;
  geometry?: MeasurementGeometry;
}

export interface ReportedMeasurementsDeps {
  post: PostToHost;
}

export interface ReportedMeasurements {
  isReported: (uid: string) => boolean;
  isBoundToRow: (uid: string) => boolean;
  wasLastSent: (uid: string, metrics: Metrics) => boolean;
  recordAdded: (uid: string, rowId: string | null, metrics: Metrics) => void;
  bindRow: (uid: string, rowId: string) => void;
  pushUpdate: (uid: string, update: MeasurementUpdate) => void;
  forget: (uid: string) => void;
  dispose: () => void;
}

export const createReportedMeasurements = ({
  post,
}: ReportedMeasurementsDeps): ReportedMeasurements => {
  // A-8: needed because MEASUREMENT_REMOVED carries only the uid (MeasurementService.ts:686-689).
  const uidToRowId = new Map<string, string>();

  // Single ADDED per uid is an OHIF detail (MeasurementService.ts:572-574), not a contract; a
  // duplicate would double the total. uidToRowId cannot serve: unarmed uids never enter it.
  const reportedUids = new Set<string>();

  // No causedBy on UPDATED (A-10): no command calls measurementService.update(), the OHIF loop
  // point (MeasurementService.ts:365-386), so an update always comes from the user's drag.
  const lastSentMetrics = new Map<string, string>();

  const updateEmitter = createThrottledEmitter<MeasurementUpdate>(
    UPDATE_INTERVAL_MS,
    (uid, { toolName, metrics, geometry }) => {
      const event: MeasurementUpdatedEvent = {
        version: 1,
        type: 'MEASUREMENT_UPDATED',
        measurementUid: uid,
        toolName,
        metrics,
        geometry,
      };

      if (!post(event)) {
        return;
      }

      lastSentMetrics.set(uid, JSON.stringify(metrics));
      console.debug(`${LOG_PREFIX} MEASUREMENT_UPDATED sent`, event);
    }
  );

  return {
    isReported: (uid: string): boolean => reportedUids.has(uid),
    isBoundToRow: (uid: string): boolean => uidToRowId.has(uid),
    wasLastSent: (uid: string, metrics: Metrics): boolean =>
      JSON.stringify(metrics) === lastSentMetrics.get(uid),

    recordAdded: (uid: string, rowId: string | null, metrics: Metrics): void => {
      reportedUids.add(uid);
      lastSentMetrics.set(uid, JSON.stringify(metrics));

      if (rowId !== null) {
        uidToRowId.set(uid, rowId);
      }
    },

    // A-14: a restored annotation never broadcasts MEASUREMENT_ADDED, so its row binding is
    // seeded here before the add, or its MEASUREMENT_UPDATED would be dropped as unbound.
    bindRow: (uid: string, rowId: string): void => {
      uidToRowId.set(uid, rowId);
    },

    pushUpdate: (uid: string, update: MeasurementUpdate): void => {
      updateEmitter.push(uid, update);
    },

    forget: (uid: string): void => {
      uidToRowId.delete(uid);
      reportedUids.delete(uid);
      lastSentMetrics.delete(uid);
      // Discard, not flush: a trailing UPDATED after REMOVED would resurrect the cleared row.
      updateEmitter.discard(uid);
    },

    dispose: (): void => {
      updateEmitter.dispose();
      lastSentMetrics.clear();
      reportedUids.clear();
      uidToRowId.clear();
    },
  };
};
