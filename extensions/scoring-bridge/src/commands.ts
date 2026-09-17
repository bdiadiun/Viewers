import { LOG_PREFIX } from './config';
import { isHostCommand } from './contract/messages';
import type {
  ActivateToolCommand,
  DeactivateToolCommand,
  FocusMeasurementCommand,
  HostCommand,
  RemoveMeasurementCommand,
} from './contract/messages';

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
  onRemoveMeasurement: (command: RemoveMeasurementCommand) => void;
  onFocusMeasurement: (command: FocusMeasurementCommand) => void;
}

export interface ToolCommands {
  handleMessage: (data: unknown) => void;
  getArmedRowId: () => string | null;
  getArmed: () => ArmedState | null;
  disarm: (reason: DisarmReason, detail?: string) => void;
}

export const createToolCommands = ({
  servicesManager,
  commandsManager,
  onRemoveMeasurement,
  onFocusMeasurement,
}: ToolCommandsDeps): ToolCommands => {
  const { toolGroupService } = servicesManager.services;

  let armed: ArmedState | null = null;

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

  const disarm = (reason: DisarmReason, detail?: string): void => {
    if (!armed) {
      return;
    }

    const toolToRestore = armed.previousTool ?? FALLBACK_TOOL;
    console.debug(
      `${LOG_PREFIX} disarming row ${armed.rowId} (${detail === undefined ? reason : `${reason} ${detail}`}); restoring tool ${toolToRestore}`
    );
    armed = null;
    activateTool(toolToRestore);
  };

  const onActivateTool = (command: ActivateToolCommand): void => {
    // A-10: re-arming would overwrite previousTool with the tool we armed ourselves.
    if (armed && armed.rowId === command.rowId) {
      console.debug(`${LOG_PREFIX} ACTIVATE_TOOL for already armed row ${command.rowId}; ignored`);
      return;
    }

    // A-4: disarm first so the snapshot below is the user's tool, not one we armed.
    if (armed) {
      disarm(DisarmReason.SwitchingRow, command.rowId);
    }

    const previousTool = readActiveTool();

    if (!activateTool(command.toolName)) {
      return;
    }

    armed = { rowId: command.rowId, requestId: command.requestId, previousTool };
    console.debug(
      `${LOG_PREFIX} armed row ${command.rowId} with ${command.toolName}; previous tool ${previousTool ?? '(unknown)'}`
    );
  };

  const onDeactivateTool = (command: DeactivateToolCommand): void => {
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

    disarm(DisarmReason.DeactivateTool);
  };

  const dispatch = (command: HostCommand): void => {
    switch (command.type) {
      case 'ACTIVATE_TOOL':
        onActivateTool(command);
        return;
      case 'DEACTIVATE_TOOL':
        onDeactivateTool(command);
        return;
      case 'REMOVE_MEASUREMENT':
        // Removing or focusing an existing annotation leaves the armed row waiting for its drawing.
        onRemoveMeasurement(command);
        return;
      case 'FOCUS_MEASUREMENT':
        onFocusMeasurement(command);
        return;
      default:
        console.warn(`${LOG_PREFIX} unhandled host command`, command);
    }
  };

  return {
    handleMessage: (data: unknown): void => {
      if (!isHostCommand(data)) {
        console.warn(`${LOG_PREFIX} ignoring message that is not a valid host command`, data);
        return;
      }

      dispatch(data);
    },
    getArmedRowId: () => armed?.rowId ?? null,
    getArmed: () => armed,
    disarm,
  };
};
