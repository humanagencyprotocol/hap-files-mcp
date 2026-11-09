#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createDb } from "./db.js";
import { save_file, list_files, get_file } from "./tools/files.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";

async function main() {
  const db = await createDb();

  const server = new Server(
    { name: "files", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, any>;
    try {
      let result: unknown;
      switch (name) {
        case "save_file": result = await save_file(db, safeArgs); break;
        case "list_files": result = await list_files(db, safeArgs); break;
        case "get_file": result = await get_file(db, safeArgs); break;
        default: throw new Error(`Unknown tool: ${name}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        ...(name === "get_file" ? { structuredContent: result as Record<string, unknown> } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[files-mcp] tool error (${name}):`, message);
      return { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], isError: true };
    }
  });

  process.on("SIGINT", () => { db.close(); process.exit(0); });

  await server.connect(new StdioServerTransport());
  console.error("[files-mcp] server started");
}

main().catch((err) => {
  console.error("[files-mcp] fatal:", err);
  process.exit(1);
});
