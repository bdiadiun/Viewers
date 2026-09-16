import { isHostCommand } from './contract/messages';
import type { ActivateToolCommand, DeactivateToolCommand, HostCommand } from './contract/messages';

/**
 * Host command handling: ACTIVATE_TOOL / DEACTIVATE_TOOL (C-4.3.3, C-4.4.1, Q-3, A-4, A-8, P-7).
 *
 * The bridge holds exactly one "armed" row at a time (A-4): arming another row cancels the
 * previous one. Arming remembers which tool the user had on the primary mouse button, so the
 * viewer can put it back on cancel, on unmount (Q-5) and — next slice — after the measurement
 * is finished (C-4.3.6).
 */

/**
 * Restored when nothing was armed before (or the active tool could not be read). WindowLevel is
 * the default primary-mouse tool of the basic/longitudinal tool group
 * (modes/basic/src/initToolGroups.ts:21-24); the assignment's wording "returns to Pan/default" is
 * loose, Pan sits on the auxiliary button there.
 */
const FALLBACK_TOOL = 'WindowLevel';

export interface ArmedState {
  /** Form row this activation belongs to; travels back on MEASUREMENT_ADDED (Q-3, A-8). */
  rowId: string;
  /** requestId of the ACTIVATE_TOOL command; becomes `causedBy` on the outgoing event (A-10). */
  requestId: string;
  /** Primary-mouse tool active at the moment of arming; null when it could not be read. */
  previousTool: string | null;
}

export interface ToolCommandsDeps {
  servicesManager: AppTypes.ServicesManager;
  commandsManager: AppTypes.CommandsManager;
}

export interface ToolCommands {
  /** Handles one already-origin-checked incoming message. Unknown shapes are warned about. */
  handleMessage: (data: unknown) => void;
  /** Row currently waiting for a drawing, or null. Read by the MEASUREMENT_ADDED path. */
  getArmedRowId: () => string | null;
  /** Full armed state, for the next slice (rowId + causedBy + tool restore after a measurement). */
  getArmed: () => ArmedState | null;
  /** Puts the pre-arming tool back and clears the armed state. No-op when nothing is armed. */
  disarm: (reason: string) => void;
}

export function createToolCommands({
  servicesManager,
  commandsManager,
}: ToolCommandsDeps): ToolCommands {
  const { toolGroupService } = servicesManager.services;

  let armed: ArmedState | null = null;

  /**
   * The tool group of the active viewport. `getToolGroup()` without an id resolves it through
   * getActiveViewportEnabledElement (ToolGroupService.ts:73-104), which is exactly the group
   * `setToolActive` will use, so both stay in agreement.
   */
  const getActiveToolGroup = () => toolGroupService?.getToolGroup();

  /**
   * Snapshot of the tool currently bound to the primary mouse button
   * (ToolGroupService.ts:241-243, same optional-id resolution as above).
   */
  const readActiveTool = (): string | null => {
    const toolName = toolGroupService?.getActivePrimaryMouseButtonTool();
    return typeof toolName === 'string' && toolName.length > 0 ? toolName : null;
  };

  /**
   * Activation goes through the `setToolActive` command
   * (extensions/cornerstone/src/commandsModule.ts:1035-1068) and not through
   * `setToolActiveToolbar` (:1025-1033): the latter loops over *every* tool group, which would arm
   * viewports the user never asked about. The toolbar highlight still follows, because
   * `toolGroup.setToolActive` emits cornerstone's TOOL_ACTIVATED and the toolbar is registered for
   * updates on that event (extensions/cornerstone/src/index.tsx:131-133), while the button state
   * itself is derived from `getActivePrimaryMouseButtonTool()`
   * (extensions/cornerstone/src/getToolbarModule.tsx:422-424).
   *
   * `setToolActive` returns silently when the tool is unknown, so we check first and report.
   */
  const activateTool = (toolName: string): boolean => {
    const toolGroup = getActiveToolGroup();

    if (!toolGroup) {
      console.error(`[scoring-bridge] no tool group for the active viewport; cannot activate ${toolName}`);
      return false;
    }

    if (!toolGroup.hasTool(toolName)) {
      // Nothing is posted back yet; the error event is part of a later slice.
      console.error(`[scoring-bridge] tool ${toolName} is not registered in tool group ${toolGroup.id}`);
      return false;
    }

    commandsManager.runCommand('setToolActive', { toolName });
    return true;
  };

  /** Restores the tool remembered at arming time (or the default) and clears `armed`. */
  const disarm = (reason: string): void => {
    if (!armed) {
      return;
    }

    const toolToRestore = armed.previousTool ?? FALLBACK_TOOL;
    console.debug(
      `[scoring-bridge] disarming row ${armed.rowId} (${reason}); restoring tool ${toolToRestore}`
    );
    armed = null;
    activateTool(toolToRestore);
  };

  const onActivateTool = (command: ActivateToolCommand): void => {
    // Idempotent re-activation of the row already armed: the viewer is in the requested state,
    // so doing it again would only overwrite `previousTool` with the tool we ourselves armed (A-10).
    if (armed && armed.rowId === command.rowId) {
      console.debug(`[scoring-bridge] ACTIVATE_TOOL for already armed row ${command.rowId}; ignored`);
      return;
    }

    // Switching rows: cancel the previous arming first, so `previousTool` snapshotted below is the
    // user's own tool and not the ROI tool we armed for the other row (A-4).
    if (armed) {
      disarm(`switching to row ${command.rowId}`);
    }

    const previousTool = readActiveTool();

    if (!activateTool(command.toolName)) {
      // Activation failed; stay unarmed so a later measurement is not mis-attributed to this row.
      return;
    }

    armed = { rowId: command.rowId, requestId: command.requestId, previousTool };
    console.debug(
      `[scoring-bridge] armed row ${command.rowId} with ${command.toolName}; previous tool ${previousTool ?? '(unknown)'}`
    );
  };

  const onDeactivateTool = (command: DeactivateToolCommand): void => {
    // Not armed at all, or armed for a different row: the requested state already holds, so this
    // is a no-op rather than an error (A-10 idempotency; e.g. a cancel racing a finished drawing).
    if (!armed) {
      console.debug(`[scoring-bridge] DEACTIVATE_TOOL for row ${command.rowId} while unarmed; ignored`);
      return;
    }

    if (armed.rowId !== command.rowId) {
      console.debug(
        `[scoring-bridge] DEACTIVATE_TOOL for row ${command.rowId} while row ${armed.rowId} is armed; ignored`
      );
      return;
    }

    disarm('DEACTIVATE_TOOL');
  };

  const dispatch = (command: HostCommand): void => {
    switch (command.type) {
      case 'ACTIVATE_TOOL':
        onActivateTool(command);
        return;
      case 'DEACTIVATE_TOOL':
        onDeactivateTool(command);
        return;
      default:
        // Unreachable while HostCommand has exactly these two members; kept so that adding a
        // command to the contract without handling it here fails the type check.
        console.warn('[scoring-bridge] unhandled host command', command);
    }
  };

  return {
    handleMessage: (data: unknown): void => {
      // Q-7: the contract guard is the only accepted way in. Anything else (a stray postMessage
      // from the host page, an older protocol version) is dropped loudly but harmlessly.
      if (!isHostCommand(data)) {
        console.warn('[scoring-bridge] ignoring message that is not a valid host command', data);
        return;
      }

      dispatch(data);
    },
    getArmedRowId: () => armed?.rowId ?? null,
    getArmed: () => armed,
    disarm,
  };
}
