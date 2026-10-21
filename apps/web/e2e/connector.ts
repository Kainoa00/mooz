/** Helpers for the connector agent's tests: the owner's assistant app, and the connector door. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, type Page } from "@playwright/test";

const clients: Client[] = [];

/** For test.afterEach: closes the assistants a test made. */
export async function closeAssistants(): Promise<void> {
  await Promise.all(clients.splice(0).map((c) => c.close()));
}

/** The owner's assistant app, played by a script: an MCP client on the connector link. */
export async function assistant(url: string): Promise<Client> {
  const client = new Client({ name: "e2e-assistant", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  clients.push(client);
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[] };
  return result.content.map((c) => c.text).join("\n");
}

export async function openConnectorDoor(owner: Page): Promise<void> {
  await owner.getByRole("button", { name: "Bring my agent" }).click();
  await owner.getByRole("tab", { name: "Grok, Claude or ChatGPT" }).click();
}

/** Makes a connector in the dialog (left open) and returns its link. */
export async function createConnector(owner: Page, name: string): Promise<string> {
  await openConnectorDoor(owner);
  await owner.getByTestId("connector-name").fill(name);
  await owner.getByTestId("connector-app").selectOption("grok");
  await owner.getByTestId("connector-create").click();
  return (await owner.getByTestId("connector-url").textContent())!.trim();
}

/** Brings the connector in (from the open dialog) and lets it in as the host. */
export async function bringAndApprove(host: Page, owner: Page, label: string): Promise<void> {
  await owner.getByTestId("connector-bring").click(); // closes the dialog
  await expect(host.getByTestId("agent-request")).toContainText(label, { timeout: 15_000 });
  await host.getByTestId("agent-request").getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByTestId("connector-panel")).toHaveAttribute("data-phase", "in", { timeout: 30_000 });
}

export const agentChat = (p: Page) => p.locator('[data-testid="chat-message"][data-kind="agent"]');

/** Everything the page would have refused under its CSP, or thrown. */
export function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}
