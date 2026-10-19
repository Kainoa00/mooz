import type { ConnectorAgent } from "./connector-agents";
import { CONNECTOR_TOPIC } from "./connector-protocol";
import type { AnswerPacket } from "./connector-queue";
import { sendToParticipant } from "./livekit";

/**
 * Hand an answer to the agent in its owner's tab, right away. Best effort: the answer
 * is kept with its question, and the tab picks it up from there if this fails.
 */
export async function deliverAnswer(agent: ConnectorAgent, packet: AnswerPacket): Promise<boolean> {
  try {
    await sendToParticipant(agent.livekitRoom, agent.identity, CONNECTOR_TOPIC, packet);
    return true;
  } catch (err) {
    console.error("could not hand an answer to its connector agent", err);
    return false;
  }
}
