import { HOST_ORIGIN, LOG_PREFIX } from './config';
import { isHostCommand } from './contract/messages';
import type {
  HostCommand,
  MeasurementAddedEvent,
  MeasurementRemovedEvent,
  MeasurementUpdatedEvent,
  MeasurementsRestoredEvent,
  ViewerReadyEvent,
} from './contract/messages';

export type ViewerEvent =
  | ViewerReadyEvent
  | MeasurementAddedEvent
  | MeasurementUpdatedEvent
  | MeasurementRemovedEvent
  | MeasurementsRestoredEvent;

export type PostToHost = (message: ViewerEvent) => boolean;

export interface CommandListenerDeps {
  onCommand: (command: HostCommand) => void;
}

export interface CommandListener {
  dispose: () => void;
}

export const postToHost: PostToHost = message => {
  if (window.parent === window) {
    console.debug(`${LOG_PREFIX} not embedded in an iframe -> skip ${message.type}`);
    return false;
  }

  window.parent.postMessage(message, HOST_ORIGIN);
  return true;
};

export const createCommandListener = ({ onCommand }: CommandListenerDeps): CommandListener => {
  // Q-2: only HOST_ORIGIN may command the viewer. Logged once, so a misconfigured origin is
  // diagnosable without flooding from browser extensions or HMR clients.
  let foreignOriginLogged = false;

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== HOST_ORIGIN) {
      if (!foreignOriginLogged) {
        foreignOriginLogged = true;
        console.debug(
          `${LOG_PREFIX} ignoring message from foreign origin ${event.origin}; expected ${HOST_ORIGIN}`
        );
      }
      return;
    }

    if (!isHostCommand(event.data)) {
      console.warn(`${LOG_PREFIX} ignoring message that is not a valid host command`, event.data);
      return;
    }

    onCommand(event.data);
  };

  window.addEventListener('message', onMessage);

  return {
    dispose: (): void => {
      window.removeEventListener('message', onMessage);
    },
  };
};
