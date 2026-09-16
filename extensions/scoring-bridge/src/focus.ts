import type { FocusMeasurementCommand } from './contract/messages';

/**
 * FOCUS_MEASUREMENT — the host asks the viewer to scroll to and highlight an annotation (S-5.3).
 *
 * One-way by design: nothing is posted back. The host already knows which row it clicked and
 * which uid it asked for, and the viewer has no *new* fact to report — where the camera ended up
 * is viewer-internal state the form does not model. So this command produces no event at all,
 * which also means it cannot start an echo loop (Q-4): it never touches the measurement itself,
 * only the viewport, so no MEASUREMENT_UPDATED / _REMOVED can come out of it.
 *
 * Idempotent (A-10): focusing a uid the service does not know is a no-op, not an error. That
 * happens legitimately — the host may still show a row whose annotation was deleted in the viewer
 * a moment ago and whose MEASUREMENT_REMOVED is still in flight.
 *
 * Stateless: this module keeps nothing between calls, so there is nothing for dispose() to clear
 * (Q-5) and no subscription to unwind.
 */

export interface FocusCommandsDeps {
  servicesManager: AppTypes.ServicesManager;
}

export interface FocusCommands {
  /** Executes one validated FOCUS_MEASUREMENT command. */
  handleFocus: (command: FocusMeasurementCommand) => void;
}

export function createFocusCommands({ servicesManager }: FocusCommandsDeps): FocusCommands {
  const { measurementService, viewportGridService } = servicesManager.services;

  const handleFocus = (command: FocusMeasurementCommand): void => {
    const { measurementUid, requestId, rowId } = command;

    if (!measurementService || !viewportGridService) {
      console.warn(
        `[scoring-bridge] FOCUS_MEASUREMENT ${requestId}: measurement/viewportGrid service unavailable; ignored`
      );
      return;
    }

    // Idempotency guard (A-10). MeasurementService.jumpToMeasurement would already bail out for an
    // unknown uid with a log.warn (MeasurementService.ts:741-745), but that is a warning about a
    // programming error, while for us an unknown uid is an ordinary race. Checking first keeps the
    // console honest. getMeasurement: MeasurementService.ts:198.
    if (!measurementService.getMeasurement(measurementUid)) {
      console.debug(
        `[scoring-bridge] FOCUS_MEASUREMENT ${requestId}: measurement ${measurementUid} (row ${rowId}) is unknown; nothing to focus`
      );
      return;
    }

    // Exactly what OHIF's own measurement panel does on a row click, one indirection shorter.
    // Panel row click -> `commandsManager.run('jumpToMeasurement', { uid, displayMeasurements })`
    // (extensions/cornerstone/src/components/MeasurementItems.tsx:26-35, via
    // MeasurementItem's onClick at :53), and that command's whole body is
    // `measurementService.jumpToMeasurement(viewportGridService.getActiveViewportId(), uid)` plus
    // marking the *panel's* display items as active (extensions/cornerstone/src/commandsModule.ts:739-744).
    // The second half is about panel rows we do not have, so we make the same service call the
    // command makes, the same way removals.ts calls remove() instead of the removeMeasurement command.
    //
    // Highlighting comes for free and is not ours to implement: jumpToMeasurement broadcasts
    // JUMP_TO_MEASUREMENT (MeasurementService.ts:740-755), the cornerstone extension subscribes to
    // it (extensions/cornerstone/src/init.tsx:210-214) and runs `jumpToMeasurementViewport`, whose
    // first statement is `cornerstoneTools.annotation.selection.setAnnotationSelected(annotationUID, true)`
    // (extensions/cornerstone/src/commandsModule.ts:208-209); the rest of that action sets the
    // viewport's view reference to the annotation's slice and moves/zooms the camera when the
    // annotation is off screen (:213-241). Calling setAnnotationSelected ourselves would duplicate
    // that line, so we do not (X-5: no reimplementation of OHIF behaviour).
    //
    // The viewport id is the *active* one, as the panel's command uses. jumpToMeasurementViewport
    // then re-resolves it to a viewport actually able to show the annotation
    // (findNavigationCompatibleViewportId, :214-218), so passing the active id is not a limitation.
    const viewportId = viewportGridService.getActiveViewportId();
    measurementService.jumpToMeasurement(viewportId, measurementUid);

    console.debug(
      `[scoring-bridge] FOCUS_MEASUREMENT ${requestId}: jumped viewport ${viewportId} to ${measurementUid} (row ${rowId})`
    );
  };

  return { handleFocus };
}
