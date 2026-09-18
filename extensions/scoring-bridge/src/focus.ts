import type { FocusMeasurementCommand } from '@bdiadiun/scoring-contract';

import { LOG_PREFIX } from './config';

// S-5.3: posts nothing back and only moves the viewport, so it cannot start an echo loop (Q-4).

export interface FocusCommandsDeps {
  servicesManager: AppTypes.ServicesManager;
}

export interface FocusCommands {
  handleFocus: (command: FocusMeasurementCommand) => void;
}

export const createFocusCommands = ({ servicesManager }: FocusCommandsDeps): FocusCommands => {
  const { measurementService, viewportGridService } = servicesManager.services;

  const handleFocus = (command: FocusMeasurementCommand): void => {
    const { measurementUid, requestId, rowId } = command;

    if (!measurementService || !viewportGridService) {
      console.warn(
        `${LOG_PREFIX} FOCUS_MEASUREMENT ${requestId}: measurement/viewportGrid service unavailable; ignored`
      );
      return;
    }

    // A-10: an unknown uid is an ordinary race (row removed, event in flight), not the programming
    // error jumpToMeasurement would log.warn about (MeasurementService.ts:741-745).
    if (!measurementService.getMeasurement(measurementUid)) {
      console.debug(
        `${LOG_PREFIX} FOCUS_MEASUREMENT ${requestId}: measurement ${measurementUid} (row ${rowId}) is unknown; nothing to focus`
      );
      return;
    }

    // The panel's command makes this same call (commandsModule.ts:739-744); cornerstone's
    // JUMP_TO_MEASUREMENT handler selects the annotation and moves the camera (:208-241).
    const viewportId = viewportGridService.getActiveViewportId();
    measurementService.jumpToMeasurement(viewportId, measurementUid);

    console.debug(
      `${LOG_PREFIX} FOCUS_MEASUREMENT ${requestId}: jumped viewport ${viewportId} to ${measurementUid} (row ${rowId})`
    );
  };

  return { handleFocus };
};
