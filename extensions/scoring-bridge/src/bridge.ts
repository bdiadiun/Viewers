import { HOST_ORIGIN } from './config';
import { createToolCommands } from './commands';
import type { ViewerReadyEvent } from './contract/messages';

/**
 * The bridge between OHIF and the embedding host-app (C-3.2, C-3.4).
 *
 * It owns the whole postMessage surface of the viewer: OHIF itself has none, so every listener,
 * every origin check and every outgoing event lives here. This slice implements the handshake
 * only (VIEWER_READY); command handling and measurement forwarding land in later slices.
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
  /** Row currently waiting for a drawing, or null. Consumed by the MEASUREMENT_ADDED slice. */
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
  // an unsubscribe closure, which is what Q-5 needs. The payload mapping is a later slice.
  if (measurementService) {
    const subscription = measurementService.subscribe(
      measurementService.EVENTS.MEASUREMENT_ADDED,
      ({ measurement }: { measurement: { uid: string } }) => {
        console.debug(
          '[scoring-bridge] MEASUREMENT_ADDED',
          measurement?.uid,
          'armed row',
          toolCommands.getArmedRowId()
        );
        // next slice: map the measurement to { rowId, measurementUid, metrics } and post it to the
        // host, then call toolCommands.disarm('measurement completed') so the tool deactivates
        // itself and the previous tool comes back (C-4.3.6).
      }
    );
    disposers.push(() => subscription.unsubscribe());
  } else {
    console.warn('[scoring-bridge] measurementService unavailable; measurements will not be seen');
  }

  // --- outgoing handshake ------------------------------------------------------------------
  let readySent = false;

  const postViewerReady = (): void => {
    if (readySent) {
      return;
    }

    // Not embedded: nothing to talk to. window.parent === window when the viewer is opened
    // directly, and posting to ourselves would only confuse the origin check above.
    if (window.parent === window) {
      console.debug('[scoring-bridge] not embedded in an iframe -> skip VIEWER_READY');
      return;
    }

    readySent = true;

    const message: ViewerReadyEvent = {
      version: 1,
      type: 'VIEWER_READY',
      viewerVersion: VIEWER_VERSION,
    };

    // Q-2: an explicit targetOrigin, never '*'.
    window.parent.postMessage(message, HOST_ORIGIN);
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
      readySent = false;
    },
  };
}
