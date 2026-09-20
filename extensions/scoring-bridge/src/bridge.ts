import { LOG_PREFIX } from './config';
import { createToolCommands, DisarmReason } from './commands';
import { createRemovalCommands } from './removals';
import { createFocusCommands } from './focus';
import { createRestoreCommands } from './restore';
import { createHandshake } from './handshake';
import { createCommandListener, postToHost } from './messaging';
import { createCommandRegistry, toCommandHandlerEntries } from './registry';
import type { CommandHandlers } from './registry';
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

  const removals = createRemovalCommands({
    servicesManager,
    post: postToHost,
    forget: reported.forget,
  });
  const focus = createFocusCommands({ servicesManager });
  const restore = createRestoreCommands({ servicesManager, reported, post: postToHost });

  const toolCommands = createToolCommands({ servicesManager, commandsManager });

  // The satisfies clause is the exhaustiveness check: a new command type in the contract fails
  // the type check here until it has a handler.
  const commandHandlers = {
    ACTIVATE_TOOL: toolCommands.handleActivateTool,
    DEACTIVATE_TOOL: toolCommands.handleDeactivateTool,
    // Removing or focusing an existing annotation leaves the armed row waiting for its drawing.
    REMOVE_MEASUREMENT: removals.handleRemove,
    FOCUS_MEASUREMENT: focus.handleFocus,
    RESTORE_MEASUREMENTS: restore.handleRestore,
  } satisfies CommandHandlers;

  const registry = createCommandRegistry();

  for (const [type, handler] of toCommandHandlerEntries(commandHandlers)) {
    registry.register(type, handler);
  }

  const stream = createMeasurementStream({
    servicesManager,
    post: postToHost,
    reported,
    getArmed: toolCommands.getArmed,
    disarm: toolCommands.disarm,
    takeCause: removals.takeCause,
  });

  const listener = createCommandListener({ onCommand: registry.dispatch });
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
