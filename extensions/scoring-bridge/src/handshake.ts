import { HOST_ORIGIN, LOG_PREFIX } from './config';
import type { PostToHost } from './messaging';
import type { ViewerReadyEvent } from './contract/messages';

const VIEWER_VERSION = process.env.VERSION_NUMBER ?? 'unknown';

export interface HandshakeDeps {
  servicesManager: AppTypes.ServicesManager;
  post: PostToHost;
}

export interface Handshake {
  dispose: () => void;
}

export const createHandshake = ({ servicesManager, post }: HandshakeDeps): Handshake => {
  const { toolGroupService } = servicesManager.services;

  let readySent = false;
  let unsubscribe: (() => void) | null = null;

  const postViewerReady = (): void => {
    if (readySent) {
      return;
    }

    const message: ViewerReadyEvent = {
      version: 1,
      type: 'VIEWER_READY',
      viewerVersion: VIEWER_VERSION,
    };

    if (!post(message)) {
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
    unsubscribe = () => subscription.unsubscribe();
  } else {
    console.warn(`${LOG_PREFIX} toolGroupService unavailable; sending VIEWER_READY immediately`);
    postViewerReady();
  }

  return {
    dispose: (): void => {
      unsubscribe?.();
      unsubscribe = null;
      readySent = false;
    },
  };
};
