import { LOG_PREFIX } from './config';
import { createToolCommands, DisarmReason } from './commands';
import { createRemovalCommands } from './removals';
import { createFocusCommands } from './focus';
import { createRestoreCommands } from './restore';
import { createHandshake } from './handshake';
import { createCommandListener, postToHost } from './messaging';
import { createMeasurementStream } from './measurementStream';
import { createReportedMeasurements } from './reportedMeasurements';

type Unsubscribe = () => void;

export interface BridgeDeps {
  servicesManager: AppTypes.ServicesManager;
  commandsManager: AppTypes.CommandsManager;
}

export interface Bridge {
  dispose: Unsubscribe;
  getArmedRowId: () => string | null;
}

export const createBridge = ({ servicesManager, commandsManager }: BridgeDeps): Bridge => {
  const reported = createReportedMeasurements({ post: postToHost });

  const removals = createRemovalCommands({ servicesManager, forget: reported.forget });
  const focus = createFocusCommands({ servicesManager });
  const restore = createRestoreCommands({ servicesManager, reported, post: postToHost });

  const toolCommands = createToolCommands({
    servicesManager,
    commandsManager,
    onRemoveMeasurement: removals.handleRemove,
    onFocusMeasurement: focus.handleFocus,
    onRestoreMeasurements: restore.handleRestore,
  });

  const stream = createMeasurementStream({
    servicesManager,
    post: postToHost,
    reported,
    getArmed: toolCommands.getArmed,
    disarm: toolCommands.disarm,
    takeCause: removals.takeCause,
  });

  const listener = createCommandListener({ onCommand: toolCommands.handleCommand });
  const handshake = createHandshake({ servicesManager, post: postToHost });

  const disposers: Unsubscribe[] = [
    reported.dispose,
    removals.dispose,
    restore.dispose,
    stream.dispose,
    listener.dispose,
    handshake.dispose,
  ];

  return {
    getArmedRowId: toolCommands.getArmedRowId,
    dispose: (): void => {
      // The doctor's tool is restored before the subscriptions go away.
      toolCommands.disarm(DisarmReason.BridgeDispose);

      while (disposers.length > 0) {
        const disposer = disposers.pop();
        try {
          disposer?.();
        } catch (error) {
          console.warn(`${LOG_PREFIX} disposer failed`, error);
        }
      }
    },
  };
};
