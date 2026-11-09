/** The MCP tool surface — kept in its own module so tests can read it without starting the server. */
const TICKET_FIELD = {
  type: "string" as const,
  description: "Ticket reference for this call, set by the governing gateway — agents do not set this.",
};

export const FILE_OUTPUT_SCHEMA = {
  type: "object",
  title: "File",
  properties: {
    filename: { type: "string", title: "Filename" },
    contentType: { type: "string", title: "Content type" },
    contentBase64: { type: "string", title: "Content (base64)" },
    sha256: { type: "string", title: "SHA-256 fingerprint", description: "Of the raw bytes of the saved file." },
    warnings: { type: "array", items: { type: "string" }, title: "Warnings", description: "Fixed sentences written by the connector when the file was saved." },
  },
  required: ["filename", "contentType", "contentBase64", "sha256"],
};

/** Where the AI must write a file before saving it — the real path, so it never has to ask the person. */
export function folderSentence(env: NodeJS.ProcessEnv = process.env): string {
  const folder = env.FILES_FOLDER;
  return folder
    ? `The shared folder is: ${folder} — write the file there first (you need to be able to write to this computer), then call this with its plain name. `
    : "No shared folder is set up yet: a person must choose one in the gateway (Connectors, Files) before any file can be saved. ";
}

/** The MCP tool surface. The folder comes from the environment the gateway started this connector with. */
export function toolDefinitions(env: NodeJS.ProcessEnv = process.env) { return [
  {
    name: "save_file",
    description:
      "Save a file that is in the shared files folder. " + folderSentence(env) + "Give only the plain file name (no folder, no path). " +
      "The connector copies the file once and checks it; the saved copy never changes. Allowed: PDF, PNG, JPEG, WebP, GIF, " +
      "MP4, WebM, Markdown and plain text, up to 18 MB. Word, Excel, SVG, HTML and zip files are refused. " +
      "Saving does not send anything.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Plain file name inside the shared folder, for example \"notes.pdf\"" },
        ticket_id: TICKET_FIELD,
      },
      required: ["file"],
    },
  },
  {
    name: "list_files",
    description: "List saved files, newest first: id, file name, content type, size and SHA-256 fingerprint.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Maximum results (default 50, at most 500)" } },
      required: [],
    },
  },
  {
    name: "get_file",
    description:
      "Read a saved file: filename, content type, base64 content and the SHA-256 fingerprint of its bytes. Used by the gateway to attach it.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["file"], description: "Which file to read" },
        id: { type: "string", description: "File id" },
      },
      required: ["kind", "id"],
    },
    outputSchema: FILE_OUTPUT_SCHEMA,
  },
];
}

export const TOOL_DEFINITIONS = toolDefinitions({});
