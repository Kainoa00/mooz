/** The minimal participant shape these helpers need (a LiveKit Participant satisfies it). */
export interface Labelled {
  name?: string;
  attributes: Readonly<Record<string, string>>;
}

export function isAgent(p: Pick<Labelled, "attributes">): boolean {
  return p.attributes.kind === "agent";
}

/** An agent named by its owner ("Kainoa's Atlas"), without the robot marker. */
export function ownedName(p: Labelled): string {
  const owner = p.attributes.owner_name;
  const name = p.name || "Agent";
  return owner ? `${owner}'s ${name}` : name;
}

/**
 * How a participant is shown everywhere in the UI. Agents always carry the robot
 * marker and their owner's name, so an agent can never pass as a person.
 */
export function participantLabel(p: Labelled): string {
  return isAgent(p) ? `🤖 ${ownedName(p)}` : p.name || "Guest";
}
