/**
 * Bridge configuration.
 *
 * Decision A-2 (docs/decisions/A-2-ports.md): the host-app runs on port 5173, the viewer on 3000.
 * HOST_ORIGIN is therefore both the only accepted origin for incoming commands and the
 * targetOrigin for every outgoing event (Q-2). It is never '*'.
 */
export const HOST_ORIGIN = 'http://localhost:5173';
