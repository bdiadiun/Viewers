import type { ActivateToolCommand, DeactivateToolCommand } from '@bdiadiun/scoring-contract';

import { LOG_PREFIX } from './config';

// The default primary-mouse tool (modes/basic/src/initToolGroups.ts:21-24); Pan, named in the
// assignment, sits on the auxiliary button.
const FALLBACK_TOOL = 'WindowLevel';

export enum DisarmReason {
  MeasurementReceived = 'measurement received',
  DeactivateTool = 'DEACTIVATE_TOOL',
  SwitchingRow = 'switching to row',
  BridgeDispose = 'bridge dispose',
}

export interface ArmedState {
  rowId: string;
  requestId: string;
  previousTool: string | null;
}

export interface ToolCommandsDeps {
  servicesManager: AppTypes.ServicesManager;
  commandsManager: AppTypes.CommandsManager;
}

export interface ToolCommands {
  handleActivateTool: (command: ActivateToolCommand) => void;
  handleDeactivateTool: (command: DeactivateToolCommand) => void;
  getArmedRowId: () => string | null;
  getArmed: () => ArmedState | null;
  disarm: (reason: DisarmReason, detail?: string) => void;
}

interface ToolControl {
  readActiveTool: () => string | null;
  activateTool: (toolName: string) => boolean;
}

interface ArmedRow {
  get: () => ArmedState | null;
  arm: (state: ArmedState) => void;
  disarm: (reason: DisarmReason, detail?: string) => void;
}

const createToolControl = ({
  servicesManager,
  commandsManager,
}: Pick<ToolCommandsDeps, 'servicesManager' | 'commandsManager'>): ToolControl => {
  const { toolGroupService } = servicesManager.services;

  // Without an id this resolves the active viewport's group, the one setToolActive uses
  // (ToolGroupService.ts:73-104).
  const getActiveToolGroup = () => toolGroupService?.getToolGroup();

  const readActiveTool = (): string | null => {
    const toolName = toolGroupService?.getActivePrimaryMouseButtonTool();
    return typeof toolName === 'string' && toolName.length > 0 ? toolName : null;
  };

  // Not setToolActiveToolbar, which arms every tool group (commandsModule.ts:1025-1068).
  // Both preconditions are checked here because setToolActive fails silently without them.
  const activateTool = (toolName: string): boolean => {
    const toolGroup = getActiveToolGroup();

    if (!toolGroup) {
      console.error(
        `${LOG_PREFIX} no tool group for the active viewport; cannot activate ${toolName}`
      );
      return false;
    }

    if (!toolGroup.hasTool(toolName)) {
      console.error(
        `${LOG_PREFIX} tool ${toolName} is not registered in tool group ${toolGroup.id}`
      );
      return false;
    }

    commandsManager.runCommand('setToolActive', { toolName });
    return true;
  };

  return { readActiveTool, activateTool };
};

const createArmedRow = ({ activateTool }: Pick<ToolControl, 'activateTool'>): ArmedRow => {
  let armed: ArmedState | null = null;

  return {
    get: (): ArmedState | null => armed,
    arm: (state: ArmedState): void => {
      armed = state;
    },

    disarm: (reason: DisarmReason, detail?: string): void => {
      if (!armed) {
        return;
      }

      const toolToRestore = armed.previousTool ?? FALLBACK_TOOL;
      console.debug(
        `${LOG_PREFIX} disarming row ${armed.rowId} (${detail === undefined ? reason : `${reason} ${detail}`}); restoring tool ${toolToRestore}`
      );
      armed = null;
      activateTool(toolToRestore);
    },
  };
};

export const createToolCommands = ({
  servicesManager,
  commandsManager,
}: ToolCommandsDeps): ToolCommands => {
  const { readActiveTool, activateTool } = createToolControl({ servicesManager, commandsManager });
  const armedRow = createArmedRow({ activateTool });

  const handleActivateTool = (command: ActivateToolCommand): void => {
    const armed = armedRow.get();

    // A-10: re-arming would overwrite previousTool with the tool we armed ourselves.
    if (armed && armed.rowId === command.rowId) {
      console.debug(`${LOG_PREFIX} ACTIVATE_TOOL for already armed row ${command.rowId}; ignored`);
      return;
    }

    // A-4: disarm first so the snapshot below is the user's tool, not one we armed.
    if (armed) {
      armedRow.disarm(DisarmReason.SwitchingRow, command.rowId);
    }

    const previousTool = readActiveTool();

    if (!activateTool(command.toolName)) {
      return;
    }

    armedRow.arm({ rowId: command.rowId, requestId: command.requestId, previousTool });
    console.debug(
      `${LOG_PREFIX} armed row ${command.rowId} with ${command.toolName}; previous tool ${previousTool ?? '(unknown)'}`
    );
  };

  const handleDeactivateTool = (command: DeactivateToolCommand): void => {
    const armed = armedRow.get();

    // A-10: already in the requested state (e.g. a cancel racing a finished drawing); a no-op.
    if (!armed) {
      console.debug(
        `${LOG_PREFIX} DEACTIVATE_TOOL for row ${command.rowId} while unarmed; ignored`
      );
      return;
    }

    if (armed.rowId !== command.rowId) {
      console.debug(
        `${LOG_PREFIX} DEACTIVATE_TOOL for row ${command.rowId} while row ${armed.rowId} is armed; ignored`
      );
      return;
    }

    armedRow.disarm(DisarmReason.DeactivateTool);
  };

  return {
    handleActivateTool,
    handleDeactivateTool,
    getArmedRowId: () => armedRow.get()?.rowId ?? null,
    getArmed: armedRow.get,
    disarm: armedRow.disarm,
  };
};
