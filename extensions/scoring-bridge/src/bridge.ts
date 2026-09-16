import { HOST_ORIGIN } from './config';
import { createToolCommands } from './commands';
import { createRemovalCommands } from './removals';
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

/**
 * The bridge between OHIF and the embedding host-app (C-3.2, C-3.4).
 *
 * It owns the whole postMessage surface of the viewer: OHIF itself has none, so every listener,
 * every origin check and every outgoing event lives here: the handshake (VIEWER_READY), the
 * incoming host commands (delegated to commands.ts) and MEASUREMENT_ADDED and
 * MEASUREMENT_UPDATED, MEASUREMENT_REMOVED.
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

  /**
   * Erases a uid from every piece of per-measurement state this bridge keeps. Assigned inside the
   * `measurementService` block below, where that state is declared; a no-op until then (and
   * forever, if there is no measurementService — in which case there is no state to erase either).
   * Declared here because the removal commands are created before that block and need it.
   */
  let forgetMeasurement: (uid: string) => void = () => undefined;

  // S-5.2: REMOVE_MEASUREMENT and the parked requestIds of the echo guard (A-10) live in
  // removals.ts; the command still arrives through the single dispatch in commands.ts.
  const removals = createRemovalCommands({
    servicesManager,
    forget: uid => forgetMeasurement(uid),
  });
  disposers.push(() => removals.dispose());

  // Command handling (ACTIVATE_TOOL / DEACTIVATE_TOOL) and the armed-row state live in commands.ts.
  const toolCommands = createToolCommands({
    servicesManager,
    commandsManager,
    onRemoveMeasurement: removals.handleRemove,
  });

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
  const postToHost = (
    message:
      | ViewerReadyEvent
      | MeasurementAddedEvent
      | MeasurementUpdatedEvent
      | MeasurementRemovedEvent
  ): boolean => {
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

    /**
     * S-5.1 — live update while a handle is dragged.
     *
     * Q-4 / P-6, echo loop. Nothing in this bridge reacts to a MEASUREMENT_* event, and nothing on
     * the host side can cause one: the host's only commands are ACTIVATE_TOOL / DEACTIVATE_TOOL,
     * which arm a tool and never touch an existing annotation. The loop point in OHIF is
     * `measurementService.update()` (MeasurementService.ts:365-386), which re-broadcasts
     * MEASUREMENT_UPDATED — we never call it, and neither does any command path in commands.ts.
     * So an UPDATED can only originate from the user dragging in the viewer; it carries no
     * `causedBy` (A-10) because there is no host request to attribute it to. If a future command
     * ever mutates a measurement, `causedBy` is the place to mark it and that command's handler is
     * the place the loop would have to be cut.
     *
     * Volume, not loops, is the real hazard here: UPDATED fires once per ANNOTATION_MODIFIED, i.e.
     * per drag frame, so the stream is throttled per measurement uid (throttle.ts) to one post per
     * UPDATE_INTERVAL_MS, always carrying the latest value and always with a trailing emit so the
     * value the handle was released on reaches the host.
     */
    const UPDATE_INTERVAL_MS = 100;

    /** Last metrics actually posted per uid, serialised — used to skip no-op corrections. */
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
        console.debug('[scoring-bridge] MEASUREMENT_UPDATED sent', event);
      }
    );
    disposers.push(() => updateEmitter.dispose());

    /**
     * The one-frame-late `cachedStats` correction (see the note further down about ADDED being
     * broadcast synchronously from the mouse-up). A short moment after ADDED we re-read the
     * measurement from the service and, if OHIF's render pass has since settled on a different
     * area, push that through the same throttled channel as a normal UPDATED. If the value is
     * already correct — the usual case — nothing is sent.
     */
    const ADDED_CORRECTION_DELAY_MS = 150;
    const correctionTimers = new Set<ReturnType<typeof setTimeout>>();
    disposers.push(() => {
      // Q-5: a timer outliving the bridge would post through a disposed channel.
      correctionTimers.forEach(timer => clearTimeout(timer));
      correctionTimers.clear();
      lastSentMetrics.clear();
    });

    const scheduleAddedCorrection = (uid: string): void => {
      const timer = setTimeout(() => {
        correctionTimers.delete(timer);

        // MeasurementService.ts:198 — read-back by uid.
        const fresh = measurementService.getMeasurement(uid) as OhifMeasurementLike | undefined;

        if (!fresh) {
          return;
        }

        const metrics = toMetrics(fresh, { quiet: true });

        if (!metrics || JSON.stringify(metrics) === lastSentMetrics.get(uid)) {
          return;
        }

        console.debug(`[scoring-bridge] correcting late cachedStats for ${uid}`);
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
      lastSentMetrics.set(uid, JSON.stringify(metrics));

      if (event.rowId !== null) {
        uidToRowId.set(uid, event.rowId);
        // S-5.1: only a measurement bound to a row can be updated in the form, so only that one
        // is worth correcting.
        scheduleAddedCorrection(uid);
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

    const onMeasurementUpdated = ({ measurement }: { measurement: OhifMeasurementLike }): void => {
      const uid = measurement?.uid;

      if (typeof uid !== 'string' || uid.length === 0) {
        return;
      }

      // Only measurements the host knows about are worth updating. A measurement drawn without
      // arming was delivered with `rowId: null` and never entered uidToRowId, so the host has no
      // row to update — sending its drag frames would be noise the host can only drop. The same
      // filter keeps annotations restored from elsewhere out of the stream.
      if (!uidToRowId.has(uid)) {
        return;
      }

      // quiet: a mid-drag frame whose cachedStats cornerstone has not recomputed yet is normal,
      // and a drag produces dozens of them; the failure is logged at debug level instead.
      const metrics = toMetrics(measurement, { quiet: true });

      if (!metrics) {
        // Mid-drag frames can legitimately carry NaN stats while cornerstone recomputes them;
        // toMetrics already said so and the next frame carries the real value.
        return;
      }

      // Not every ANNOTATION_MODIFIED changes the numbers — selecting or deselecting an annotation
      // also fires one. Re-sending a value the host already has is pure noise, so it is dropped
      // here rather than after the throttle, which keeps the trailing emit meaningful.
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

    // --- removals ---------------------------------------------------------------------------
    /**
     * Everything this bridge remembers about one measurement, dropped in one place. Called from
     * the MEASUREMENT_REMOVED subscriber below (whatever caused the deletion) and from the
     * REMOVE_MEASUREMENT handler (removals.ts), which also reaches it for a uid that was already
     * gone. Assigning the outer binding rather than declaring a new one: this state only exists
     * when measurementService does.
     */
    forgetMeasurement = (uid: string): void => {
      uidToRowId.delete(uid);
      reportedUids.delete(uid);
      lastSentMetrics.delete(uid);
      // S-5.1 x S-5.2: a drag frame can still be sitting in the trailing timer when the annotation
      // is deleted. Flushing it would post a MEASUREMENT_UPDATED for a measurement that no longer
      // exists and, at the host, resurrect the value of a row that has just been cleared — so the
      // pending value is discarded, not emitted.
      updateEmitter.discard(uid);
    };

    /**
     * S-5.2, the viewer -> host half: whoever deleted the annotation, the host hears about it.
     *
     * P-6, the echo-loop point (Q-4, A-10). This subscriber is the other end of the loop described
     * in removals.ts: a REMOVE_MEASUREMENT command makes OHIF broadcast exactly the event this
     * handler forwards. The two guards are:
     *   - `causedBy` — `takeCause` returns the requestId parked by the handler a moment ago (the
     *     broadcast is synchronous, MeasurementService.ts:674-689), so the host can recognise the
     *     answer to its own command and not delete the row a second time. Absent when the deletion
     *     started in the viewer, which is precisely the case the host must act on;
     *   - idempotency, in the command handler — a REMOVE_MEASUREMENT for a uid that is already
     *     gone produces no service call and therefore no event, so a loop cannot even get started.
     *
     * The event is posted for *every* uid, bound to a row or not: the viewer does not decide what
     * the host's rows are (A-8). An unbound uid is simply one the host has nothing to do with.
     *
     * Payload shape: `{ source, measurement }` where `measurement` is the **uid string**, not the
     * measurement object (MeasurementService.ts:686-689). `source` is kept out of the contract —
     * it is an OHIF-internal mapping source, meaningless to the host.
     */
    const onMeasurementRemoved = ({ measurement }: { measurement: unknown }): void => {
      const uid = typeof measurement === 'string' ? measurement : undefined;

      if (uid === undefined || uid.length === 0) {
        console.warn('[scoring-bridge] MEASUREMENT_REMOVED without a uid; ignored', measurement);
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

      console.debug('[scoring-bridge] MEASUREMENT_REMOVED sent', event);
    };

    const removedSubscription = measurementService.subscribe(
      measurementService.EVENTS.MEASUREMENT_REMOVED,
      onMeasurementRemoved
    );
    disposers.push(() => removedSubscription.unsubscribe());

    // Why the post-ADDED correction above exists, measured while verifying the ADDED slice:
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
