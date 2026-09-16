import { HOST_ORIGIN } from './config';
import { createToolCommands } from './commands';
import { toMetrics } from './measurements';
import type { OhifMeasurementLike } from './measurements';
import type { MeasurementAddedEvent, ViewerReadyEvent } from './contract/messages';

/**
 * The bridge between OHIF and the embedding host-app (C-3.2, C-3.4).
 *
 * It owns the whole postMessage surface of the viewer: OHIF itself has none, so every listener,
 * every origin check and every outgoing event lives here: the handshake (VIEWER_READY), the
 * incoming host commands (delegated to commands.ts) and MEASUREMENT_ADDED. MEASUREMENT_UPDATED /
 * REMOVED are bonus slices.
 */

type Unsubscribe = () => void;

export interface BridgeDeps {
  /** OHIF services container; we use measurementService and (optionally) toolGroupService. */
  servicesManager: AppTypes.ServicesManager;
  /** Used by ACTIVATE_TOOL / DEACTIVATE_TOOL via commandsManager.runCommand('setToolActive'). */
  commandsManager: AppTypes.CommandsManager;
}

export interface Bridge {
  /** Removes every listener and subscription this bridge created (Q-5). */
  dispose: Unsubscribe;
  /** Row currently waiting for a drawing, or null. */
  getArmedRowId: () => string | null;
}

/**
 * The viewer build version, injected by webpack DefinePlugin from version.txt:
 * .webpack/webpack.base.js:32,46 ('process.env.VERSION_NUMBER'). Used by
 * extensions/default/src/customizations/aboutModalCustomization.tsx:10 the same way.
 */
const VIEWER_VERSION = process.env.VERSION_NUMBER ?? 'unknown';

export function createBridge({ servicesManager, commandsManager }: BridgeDeps): Bridge {
  const { measurementService, toolGroupService } = servicesManager.services;

  const disposers: Unsubscribe[] = [];

  // Command handling (ACTIVATE_TOOL / DEACTIVATE_TOOL) and the armed-row state live in commands.ts.
  const toolCommands = createToolCommands({ servicesManager, commandsManager });

  /**
   * A-8: the viewer-side half of the correlation. The host issues `rowId`, the viewer issues
   * `measurementUid`, and this map is where the viewer remembers the pairing. It is not needed to
   * emit MEASUREMENT_ADDED (the armed row is known at that moment) — it is needed for
   * MEASUREMENT_UPDATED and especially MEASUREMENT_REMOVED, which delivers only the uid string
   * (MeasurementService.ts:686-689) and so cannot be attributed to a row any other way.
   */
  const uidToRowId = new Map<string, string>();

  /**
   * The only outgoing channel. Q-2: an explicit targetOrigin, never '*'. Not embedded means there
   * is nothing to talk to — window.parent === window when the viewer is opened directly, and
   * posting to ourselves would only bounce off our own origin check.
   */
  const postToHost = (message: ViewerReadyEvent | MeasurementAddedEvent): boolean => {
    if (window.parent === window) {
      console.debug(`[scoring-bridge] not embedded in an iframe -> skip ${message.type}`);
      return false;
    }

    window.parent.postMessage(message, HOST_ORIGIN);
    return true;
  };

  // --- incoming messages -------------------------------------------------------------------
  // Q-2: everything that does not come from HOST_ORIGIN is dropped. We warn once so that a
  // misconfigured origin is diagnosable without flooding the console from unrelated senders
  // (browser extensions, dev-server HMR clients) and without throwing inside a listener.
  let foreignOriginLogged = false;

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== HOST_ORIGIN) {
      if (!foreignOriginLogged) {
        foreignOriginLogged = true;
        console.debug(
          `[scoring-bridge] ignoring message from foreign origin ${event.origin}; expected ${HOST_ORIGIN}`
        );
      }
      return;
    }

    // Origin is trusted from here on; the shape still is not (Q-7).
    toolCommands.handleMessage(event.data);
  };

  window.addEventListener('message', onMessage);
  disposers.push(() => window.removeEventListener('message', onMessage));

  // --- measurement subscription ------------------------------------------------------------
  // P-4: this is the single place where the viewer learns that an annotation was completed.
  // We subscribe on measurementService rather than on raw cornerstone events because the service
  // collapses ANNOTATION_ADDED + ANNOTATION_COMPLETED into one MEASUREMENT_ADDED
  // (platform/core/src/services/MeasurementService/MeasurementService.ts:545-576) and hands back
  // an unsubscribe closure, which is what Q-5 needs. The payload mapping lives in measurements.ts.
  if (measurementService) {
    /**
     * Guard against double delivery. The service is expected to broadcast ADDED exactly once per
     * completed annotation (the ANNOTATION_ADDED pass stores it without broadcasting,
     * MeasurementService.ts:572-574, and only the ANNOTATION_COMPLETED pass emits). That is an
     * OHIF implementation detail, not a contract, and a second ADDED for the same uid would give
     * the host a duplicate row and a wrong total (C-4.3.8). The uid is the cornerstone
     * annotationUID and is stable, so it is the natural identity for "already handled".
     * uidToRowId cannot serve as this set: unarmed measurements are never put in it.
     */
    const reportedUids = new Set<string>();

    const onMeasurementAdded = ({ measurement }: { measurement: OhifMeasurementLike }): void => {
      const uid = measurement?.uid;

      if (typeof uid !== 'string' || uid.length === 0) {
        console.warn('[scoring-bridge] MEASUREMENT_ADDED without a uid; ignored', measurement);
        return;
      }

      if (reportedUids.has(uid)) {
        console.debug(`[scoring-bridge] MEASUREMENT_ADDED for ${uid} already handled; ignored`);
        return;
      }

      const metrics = toMetrics(measurement);

      if (!metrics) {
        // toMetrics already said why. Nothing is posted: a MEASUREMENT_ADDED without a usable
        // value would leave the row stuck between "drawing" and "done" (C-4.3.6). The arming is
        // left in place so the user can simply draw again.
        console.warn(
          `[scoring-bridge] no metrics for measurement ${uid}; nothing sent to the host`
        );
        return;
      }

      // A-8: a measurement drawn while nothing is armed (straight from the OHIF toolbar) is still
      // forwarded, with rowId: null. The viewer does not decide what to do with it — the host does.
      const armed = toolCommands.getArmed();

      const event: MeasurementAddedEvent = {
        version: 1,
        type: 'MEASUREMENT_ADDED',
        rowId: armed?.rowId ?? null,
        measurementUid: uid,
        toolName: typeof measurement.toolName === 'string' ? measurement.toolName : '',
        metrics,
        // A-10: echoes the ACTIVATE_TOOL that caused this drawing, so the host can tell an event
        // it provoked from one the user produced on their own.
        causedBy: armed?.requestId,
      };

      if (!postToHost(event)) {
        return;
      }

      reportedUids.add(uid);

      if (event.rowId !== null) {
        uidToRowId.set(uid, event.rowId);
      }

      console.debug('[scoring-bridge] MEASUREMENT_ADDED sent', event);

      // C-4.3.6: the tool deactivates by itself once the value is on its way, putting back the
      // tool the user had before arming. Done after posting so a failing restore cannot swallow
      // the event.
      if (armed) {
        toolCommands.disarm('measurement received');
      }
    };

    const subscription = measurementService.subscribe(
      measurementService.EVENTS.MEASUREMENT_ADDED,
      onMeasurementAdded
    );
    disposers.push(() => subscription.unsubscribe());

    // MEASUREMENT_UPDATED is deliberately not handled here: it fires once per ANNOTATION_MODIFIED,
    // i.e. per drag frame, and needs throttling plus the echo guard of A-10. It belongs to the
    // bonus slice S-5.1 together with MEASUREMENT_REMOVED (S-5.2), which will resolve its row
    // through uidToRowId.
    //
    // Measured while verifying this slice, and the reason that slice matters beyond "live edits":
    // cornerstone fills `cachedStats` in its annotation render pass, which is scheduled, while
    // MEASUREMENT_ADDED is broadcast synchronously from the mouse-up. If the last pointer move and
    // the release land in the same frame (a fast flick, or synthetic input), the area read here is
    // one render behind; it settles a few frames later and a trailing MEASUREMENT_UPDATED carries
    // the final value. Waiting a fixed number of frames here would be a guess, so the value is
    // taken as OHIF has it at completion and the correction is left to the UPDATED stream.
  } else {
    console.warn('[scoring-bridge] measurementService unavailable; measurements will not be seen');
  }

  // --- outgoing handshake ------------------------------------------------------------------
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
    console.debug('[scoring-bridge] VIEWER_READY sent to', HOST_ORIGIN);
  };

  // When to announce readiness (C-4.4.1: "viewer loaded and ready for commands").
  //
  // preRegistration runs during appInit, long before the /viewer route mounts. At that moment
  // commandsManager.runCommand('setToolActive', ...) is registered but useless: the command
  // resolves the tool group of the active viewport and returns silently when there is none
  // (extensions/cornerstone/src/commandsModule.ts:1050-1055). A command sent that early would be
  // accepted and lost, which is exactly what Q-1 forbids.
  //
  // The earliest moment at which setToolActive really works is when a viewport has been added to
  // a tool group, signalled by toolGroupService.EVENTS.VIEWPORT_ADDED
  // (extensions/cornerstone/src/services/ToolGroupService/ToolGroupService.ts:8). We announce
  // readiness on the first such event and then unsubscribe.
  if (toolGroupService) {
    const subscription = toolGroupService.subscribe(
      toolGroupService.EVENTS.VIEWPORT_ADDED,
      postViewerReady
    );
    disposers.push(() => subscription.unsubscribe());
  } else {
    // Risk accepted and made visible: without the cornerstone extension there is no tool group
    // signal at all, so we fall back to announcing readiness immediately. Commands may then
    // arrive before a viewport exists.
    console.warn('[scoring-bridge] toolGroupService unavailable; sending VIEWER_READY immediately');
    postViewerReady();
  }

  return {
    getArmedRowId: toolCommands.getArmedRowId,
    dispose: () => {
      // Q-5: the armed state is part of the cleanup. Restore the user's tool before the listeners
      // go away, otherwise the viewer would be left waiting for a drawing nobody will report.
      toolCommands.disarm('bridge dispose');

      while (disposers.length > 0) {
        const disposer = disposers.pop();
        try {
          disposer?.();
        } catch (error) {
          console.warn('[scoring-bridge] disposer failed', error);
        }
      }
      // Q-5: the correlation map is bridge state, not page state; a disposed bridge must not leave
      // uid -> rowId entries of a session that no longer exists behind it.
      uidToRowId.clear();
      readySent = false;
    },
  };
}
