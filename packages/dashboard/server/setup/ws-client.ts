/**
 * `WsClient` shape — preserves the structural typing the legacy
 * `handleClientMessage` branches relied on (`readyState` +
 * `send(json)`) so the socket.io fauxWs adapter, `sendInit`, and
 * every WS action handler can share one surface.
 *
 * Hoisted into `setup/` because both the init-payload sender and the
 * server-listen factory need to import it without dragging
 * dashboard-server's whole closure scope along.
 */

export type WsClient = {
  readyState: number;
  send(data: string): void;
};

/** `WebSocket.OPEN` value — kept as a const so we don't depend on the `ws` types. */
export const WS_OPEN = 1;
