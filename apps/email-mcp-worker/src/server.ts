import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  publicAccounts,
  type EmailCatalog,
  type EmailFeatureGates,
} from "./config.js";

const accountOutputSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  address: z.string(),
  provider: z.enum(["qq", "gmail", "icloud", "fastmail", "custom"]),
  default: z.boolean(),
  read_enabled: z.boolean(),
  modify_enabled: z.boolean(),
  send_enabled: z.boolean(),
});

export function listAccountMetadata(
  catalog: EmailCatalog,
  gates: EmailFeatureGates,
) {
  return { accounts: publicAccounts(catalog, gates) };
}

export function buildEmailServer(
  catalog: EmailCatalog,
  gates: EmailFeatureGates,
): McpServer {
  const server = new McpServer({
    name: "email-mcp-worker",
    version: "0.1.0",
  });

  server.registerTool(
    "email_accounts",
    {
      description:
        "List configured email accounts and non-secret read/modify/send capability flags. Credentials and mail server endpoints are never returned.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({}),
      outputSchema: z.object({
        accounts: z.array(accountOutputSchema),
      }),
    },
    async () => {
      const data = listAccountMetadata(catalog, gates);
      return {
        content: [
          {
            type: "text" as const,
            text: "Configured email account metadata returned in structuredContent.",
          },
        ],
        structuredContent: data,
      };
    },
  );

  return server;
}
