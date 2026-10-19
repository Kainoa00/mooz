/**
 * Connector agents, as the owner's browser tab sees them (safe to use in the client).
 *
 * The server sends the agent its assistant's answers as LiveKit data packets on topic
 * `mooz.connector`, addressed to the agent's identity. Only the server sends these: a
 * packet from any participant is ignored.
 */

export const CONNECTOR_TOPIC = "mooz.connector";
