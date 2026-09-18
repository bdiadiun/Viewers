import { annotation } from '@cornerstonejs/tools';
import { triggerAnnotationRenderForViewportIds } from '@cornerstonejs/tools/utilities';

import { LOG_PREFIX } from './config';
import type { PostToHost } from './messaging';
import type { ReportedMeasurements } from './reportedMeasurements';
import {
  isMeasurementGeometry,
  type MeasurementsRestoredEvent,
  type RestoreFailure,
  type RestoreFailureReason,
  type RestoreMeasurementRequest,
  type RestoreMeasurementsCommand,
} from './contract/messages';

// A-14 / S-5.6. No value is posted from here: cornerstone recomputes cachedStats in the render
// pass this triggers and the existing MEASUREMENT_UPDATED path delivers it, which is why the
// uid -> rowId map is seeded before the annotation is added.

export interface RestoreCommandsDeps {
  servicesManager: AppTypes.ServicesManager;
  reported: ReportedMeasurements;
  post: PostToHost;
}

export interface RestoreCommands {
  handleRestore: (command: RestoreMeasurementsCommand) => void;
  dispose: () => void;
}

interface ReadinessGate {
  whenReady: (run: () => void) => void;
  dispose: () => void;
}

const failAll = (
  measurements: RestoreMeasurementRequest[],
  reason: RestoreFailureReason
): RestoreFailure[] => measurements.map(({ rowId }) => ({ rowId, reason }));

// Hand-built rather than EllipticalROITool.hydrate: that one re-derives metadata from the live
// camera, needs an enabled element and drops the label (ohif-annotation-restore.md §1).
const toAnnotation = ({ measurementUid, toolName, geometry }: RestoreMeasurementRequest) => ({
  annotationUID: measurementUid,
  metadata: {
    toolName,
    FrameOfReferenceUID: geometry.frameOfReferenceUid,
    referencedImageId: geometry.referencedImageId,
  },
  data: {
    // activeHandleIndex must be null, not absent: the renderer treats `!== null` as "a handle is
    // active" and then indexes the canvas coordinates with undefined (EllipticalROITool.js:445).
    handles: { points: geometry.points, activeHandleIndex: null },
    label: geometry.label,
  },
  // Makes cornerstone recompute the stats and emit ANNOTATION_MODIFIED afterwards.
  invalidated: true,
});

// The viewport holds a cornerstone viewport only once its display set data has been set
// (CornerstoneViewportService.ts:509), the moment VIEWPORT_DATA_CHANGED reports (:492, :1229).
const createReadinessGate = (
  servicesManager: AppTypes.ServicesManager,
  getViewportId: () => string | undefined
): ReadinessGate => {
  const { cornerstoneViewportService } = servicesManager.services;
  const gates = new Set<{ unsubscribe: () => void }>();

  const isReady = (): boolean => {
    const viewportId = getViewportId();
    return Boolean(viewportId && cornerstoneViewportService?.getCornerstoneViewport(viewportId));
  };

  return {
    whenReady: (run: () => void): void => {
      if (isReady() || !cornerstoneViewportService) {
        run();
        return;
      }

      const subscription = cornerstoneViewportService.subscribe(
        cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED,
        () => {
          subscription.unsubscribe();
          gates.delete(subscription);
          run();
        }
      );

      gates.add(subscription);
    },

    dispose: (): void => {
      gates.forEach(subscription => subscription.unsubscribe());
      gates.clear();
    },
  };
};

const createRowRestorer =
  ({ servicesManager, reported }: Omit<RestoreCommandsDeps, 'post'>) =>
  (request: RestoreMeasurementRequest): RestoreFailureReason | null => {
    if (servicesManager.services.measurementService?.getMeasurement(request.measurementUid)) {
      return 'already-present';
    }

    if (!isMeasurementGeometry(request.geometry)) {
      return 'invalid-geometry';
    }

    try {
      reported.bindRow(request.measurementUid, request.rowId);
      // No group selector: metadata.FrameOfReferenceUID is the group key (addSRAnnotation.ts:142).
      annotation.state.addAnnotation(toAnnotation(request));
      return null;
    } catch (error) {
      console.error(`${LOG_PREFIX} restoring ${request.measurementUid} failed`, error);
      reported.forget(request.measurementUid);
      return 'viewer-error';
    }
  };

export const createRestoreCommands = (deps: RestoreCommandsDeps): RestoreCommands => {
  const { servicesManager, post } = deps;
  const { displaySetService, viewportGridService } = servicesManager.services;

  const activeViewportId = (): string | undefined => viewportGridService?.getActiveViewportId();
  const gate = createReadinessGate(servicesManager, activeViewportId);
  const restoreRow = createRowRestorer(deps);

  // The study the viewer shows is the one its loaded display sets belong to
  // (DisplaySetService.ts:114, getActiveDisplaySets).
  const showsStudy = (studyInstanceUid: string): boolean =>
    (displaySetService?.getActiveDisplaySets() ?? []).some(
      displaySet => displaySet.StudyInstanceUID === studyInstanceUid
    );

  const runRestore = (command: RestoreMeasurementsCommand): void => {
    const restored: string[] = [];
    const failed: RestoreFailure[] = showsStudy(command.studyInstanceUid)
      ? []
      : failAll(command.measurements, 'unknown-study');

    if (failed.length === 0) {
      command.measurements.forEach(request => {
        const reason = restoreRow(request);
        if (reason === null) {
          restored.push(request.rowId);
        } else {
          failed.push({ rowId: request.rowId, reason });
        }
      });
    }

    const viewportId = activeViewportId();

    if (restored.length > 0 && viewportId) {
      triggerAnnotationRenderForViewportIds([viewportId]);
    }

    const event: MeasurementsRestoredEvent = {
      version: 1,
      type: 'MEASUREMENTS_RESTORED',
      causedBy: command.requestId,
      restored,
      failed,
    };

    if (post(event)) {
      console.debug(`${LOG_PREFIX} MEASUREMENTS_RESTORED sent`, event);
    }
  };

  return {
    handleRestore: (command: RestoreMeasurementsCommand): void => {
      gate.whenReady(() => runRestore(command));
    },

    dispose: gate.dispose,
  };
};
