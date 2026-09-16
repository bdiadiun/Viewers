import type { RemoveMeasurementCommand } from './contract/messages';

/**
 * REMOVE_MEASUREMENT — the host asks the viewer to delete an annotation (S-5.2).
 *
 * P-6, the echo-loop point (Q-4, decision A-10). Deletion is the one flow that is truly
 * bidirectional: the host's command makes OHIF broadcast MEASUREMENT_REMOVED, and the bridge
 * forwards every MEASUREMENT_REMOVED back to the host, so a naive implementation on both sides
 * would be host -> viewer -> host -> viewer forever. Two independent guards cut it:
 *
 * 1. `causedBy` (here): before calling `measurementService.remove()` the requestId is parked in
 *    `pendingRemovals` under the uid. The service broadcasts MEASUREMENT_REMOVED *synchronously*
 *    from inside that call (MeasurementService.ts:674-689), so the subscriber in bridge.ts finds
 *    the entry, stamps the outgoing event with `causedBy: requestId` and the host recognises the
 *    event as the answer to its own command instead of as news from the viewer.
 * 2. Idempotency (here): a REMOVE_MEASUREMENT for a uid the service no longer knows does nothing
 *    at all — no service call, therefore no event, therefore nothing for the host to react to.
 *    This is what stops a loop that has already started, and it also makes a retry harmless.
 *
 * Guard 1 needs guard 2: if `causedBy` were the only protection, a host that ignores it (an older
 * build, a different embedder) would still ping-pong. Guard 2 alone would be enough to terminate
 * the loop, but only after one useless extra round trip, and the host could not tell an echo from
 * a deletion the user performed in the viewer at the same moment.
 */

export interface RemovalCommandsDeps {
  servicesManager: AppTypes.ServicesManager;
  /**
   * Drops every trace of a uid from the bridge's per-measurement state (row mapping, throttled
   * updates, last-sent values). Called even when the measurement is already gone, so that a stale
   * mapping left by an out-of-band deletion cannot outlive the host's knowledge of it.
   */
  forget: (uid: string) => void;
}

export interface RemovalCommands {
  /** Executes one validated REMOVE_MEASUREMENT command. */
  handleRemove: (command: RemoveMeasurementCommand) => void;
  /**
   * Returns the requestId parked for `uid` and consumes it, or undefined when the deletion did
   * not come from a host command. Read once, by the MEASUREMENT_REMOVED subscriber.
   */
  takeCause: (uid: string) => string | undefined;
  /** Q-5: drops the parked requestIds, so a disposed bridge keeps no per-session state. */
  dispose: () => void;
}

export function createRemovalCommands({
  servicesManager,
  forget,
}: RemovalCommandsDeps): RemovalCommands {
  const { measurementService } = servicesManager.services;

  /** uid -> requestId of the REMOVE_MEASUREMENT command currently being executed for it. */
  const pendingRemovals = new Map<string, string>();

  const handleRemove = (command: RemoveMeasurementCommand): void => {
    const { measurementUid, requestId, rowId } = command;

    if (!measurementService) {
      console.warn(
        `[scoring-bridge] REMOVE_MEASUREMENT ${requestId}: measurementService unavailable; ignored`
      );
      return;
    }

    // Guard 2 (A-10 idempotency). MeasurementService.remove() would already return silently for an
    // unknown uid (MeasurementService.ts:675-680), but relying on that would also mean relying on
    // it *not* broadcasting; checking here makes "no measurement -> no event" our own guarantee.
    // getMeasurement: MeasurementService.ts:198.
    if (!measurementService.getMeasurement(measurementUid)) {
      console.debug(
        `[scoring-bridge] REMOVE_MEASUREMENT ${requestId}: measurement ${measurementUid} (row ${rowId}) is already gone; nothing to do`
      );
      // The host and the viewer agree about the outcome, so this is success, not an error: the
      // row is empty either way. Only our own bookkeeping may still hold the uid.
      forget(measurementUid);
      return;
    }

    // Guard 1 (A-10 causedBy). Parked *before* the call, because remove() broadcasts synchronously.
    pendingRemovals.set(measurementUid, requestId);

    try {
      // Why the service and not the `removeMeasurement` command: the command is a one-line wrapper
      // around exactly this call (extensions/cornerstone/src/commandsModule.ts:746-751), so going
      // through commandsManager would only add an indirection. The drawing disappears from the
      // viewport because the cornerstone extension listens to MEASUREMENT_REMOVED itself and calls
      // removeAnnotation() + renderingEngine.render() (initMeasurementService.ts:501-522).
      // Signature at this OHIF version: remove(measurementUID: string) — one argument only
      // (MeasurementService.ts:674).
      measurementService.remove(measurementUid);
    } finally {
      // If remove() threw before broadcasting, the parked requestId would otherwise be stamped on
      // an unrelated later deletion of the same uid.
      pendingRemovals.delete(measurementUid);
    }

    forget(measurementUid);
    console.debug(
      `[scoring-bridge] REMOVE_MEASUREMENT ${requestId}: removed ${measurementUid} (row ${rowId})`
    );
  };

  return {
    handleRemove,
    takeCause: (uid: string): string | undefined => {
      const requestId = pendingRemovals.get(uid);
      pendingRemovals.delete(uid);
      return requestId;
    },
    dispose: (): void => {
      pendingRemovals.clear();
    },
  };
}
