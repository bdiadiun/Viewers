import type { HostCommand } from '@bdiadiun/scoring-contract';

import { LOG_PREFIX } from './config';

export type CommandType = HostCommand['type'];

export type CommandOfType<TType extends CommandType> = Extract<HostCommand, { type: TType }>;

export type CommandHandler<TType extends CommandType> = (command: CommandOfType<TType>) => void;

// A handler per command type; used with `satisfies` so a new type in the contract fails the
// type check until a handler exists for it.
export type CommandHandlers = { [TType in CommandType]: CommandHandler<TType> };

export type CommandHandlerEntry = readonly [CommandType, CommandHandler<CommandType>];

export interface CommandRegistry {
  register: <TType extends CommandType>(type: TType, handler: CommandHandler<TType>) => void;
  dispatch: (command: HostCommand) => void;
}

// Object.entries widens the keys to string and loses the key-to-handler correlation; dispatch
// restores it by only ever calling a handler with the type it was registered under.
export const toCommandHandlerEntries = (handlers: CommandHandlers): CommandHandlerEntry[] =>
  Object.entries(handlers) as CommandHandlerEntry[];

// A stored handler accepts only the command type it was registered under; `never` keeps the
// store assignable from every handler and forces dispatch to state that guarantee once.
type StoredHandler = (command: never) => void;

export const createCommandRegistry = (): CommandRegistry => {
  const handlers = new Map<CommandType, StoredHandler>();
  const unknownTypesLogged = new Set<string>();

  return {
    register: <TType extends CommandType>(type: TType, handler: CommandHandler<TType>): void => {
      if (handlers.has(type)) {
        console.warn(`${LOG_PREFIX} handler for ${type} replaced by a later registration`);
      }

      handlers.set(type, handler);
    },

    dispatch: (command: HostCommand): void => {
      const handler = handlers.get(command.type) as CommandHandler<CommandType> | undefined;

      if (!handler) {
        // A newer host may send a command this viewer does not know yet; logged once per type so
        // it stays diagnosable without flooding the console.
        if (!unknownTypesLogged.has(command.type)) {
          unknownTypesLogged.add(command.type);
          console.warn(`${LOG_PREFIX} no handler registered for host command ${command.type}`);
        }
        return;
      }

      handler(command);
    },
  };
};
