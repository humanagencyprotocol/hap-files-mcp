/** The MCP tool surface — kept in its own module so tests can read it without starting the server. */
const TICKET_FIELD = {
  type: "string" as const,
  description: "Ticket reference for this call, set by the governing gateway — agents do not set this.",
};

export const DOCUMENT_OUTPUT_SCHEMA = {
  type: "object",
  title: "Document",
  properties: {
    filename: { type: "string", title: "Filename" },
    contentType: { type: "string", title: "Content type" },
    contentBase64: { type: "string", title: "Content (base64)" },
    sha256: { type: "string", title: "SHA-256 fingerprint", description: "Of the raw bytes of the saved document." },
    warnings: { type: "array", items: { type: "string" }, title: "Warnings", description: "Fixed sentences written by the connector when the document was saved." },
  },
  required: ["filename", "contentType", "contentBase64", "sha256"],
};

export const TOOL_DEFINITIONS = [
  {
    name: "save_document",
    description:
      "Save a file that is in the shared documents folder. Give only the plain file name (no folder, no path). " +
      "The connector copies the file once and checks it; the saved copy never changes. Allowed: PDF, PNG, JPEG, WebP, GIF, " +
      "MP4, WebM, Markdown and plain text, up to 25 MB. Word, Excel, SVG, HTML and zip files are refused. " +
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
    name: "list_documents",
    description: "List saved documents, newest first: id, file name, content type, size and SHA-256 fingerprint.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Maximum results (default 50, at most 500)" } },
      required: [],
    },
  },
  {
    name: "get_document",
    description:
      "Read a saved document: filename, content type, base64 content and the SHA-256 fingerprint of its bytes. Used by the gateway to attach it.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["file"], description: "Which document to read" },
        id: { type: "string", description: "Document id" },
      },
      required: ["kind", "id"],
    },
    outputSchema: DOCUMENT_OUTPUT_SCHEMA,
  },
];
