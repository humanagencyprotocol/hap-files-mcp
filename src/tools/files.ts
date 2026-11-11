import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { dataDir } from "../db.js";
import { requireBareName, filterFilename, Refusal } from "../lib/name.js";
import { readFromSharedFolder, type OpenHooks } from "../lib/safeopen.js";
import { detectType } from "../lib/detect.js";
import { checkPdf } from "../lib/pdf.js";
import { checkSharedFolder, CHANGE_FOLDER_STEP, suggestFolderStep } from "../lib/folder.js";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const storeDir = (env: NodeJS.ProcessEnv) => path.join(dataDir(env), "files-store");

interface Row {
  id: string; filename: string; content_type: string; bytes: number; sha256: string; created_at: string; warnings: string;
}

/** Rules 1–6, in order. Every failure is a plain refusal and stores nothing. */
export async function save_file(
  db: Db, args: Record<string, any>, env: NodeJS.ProcessEnv = process.env, hooks: OpenHooks = {},
) {
  const check = checkSharedFolder(env);                          // 0: the folder can be used now
  if (!check.ok) {
    if (check.folder === undefined) {
      throw new Refusal("Refused: no shared folder is set up for files. A person opens **Connectors**, the card **Files**, presses **Edit credentials**, enters the full path under **Shared folder** and saves. " +
        `${suggestFolderStep()} Tell the person; do not try another way.`);
    }
    throw new Refusal(`Refused: ${check.problem} ${CHANGE_FOLDER_STEP}`);
  }
  const folder = check.folder;
  let bytes: Buffer, filename: string, contentType: string, warnings: string[];
  try {
    const name = requireBareName(args.file, process.platform, folder); // 1
    ({ bytes } = readFromSharedFolder(folder, name, hooks));       // 2 + 3 (handle only; size)
    filename = filterFilename(name);
    const detected = detectType(bytes, filename);                  // 4
    if (!detected.ok) throw new Refusal(detected.message);
    contentType = detected.contentType;
    warnings = contentType === "application/pdf" ? checkPdf(bytes) : []; // 5
  } catch (e) {
    // Every refusal names the folder, so the AI never has to ask for it.
    if (e instanceof Refusal && !e.message.includes(folder)) throw new Refusal(`${e.message} The shared folder is ${folder}.`);
    throw e;
  }

  // 6: the very bytes read in step 2.
  const id = randomUUID();
  const digest = sha256(bytes);
  const dir = storeDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, id);
  const fd = fs.openSync(dest, "wx", 0o444); // never overwrite
  try {
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(dest, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  const ticketId = typeof args.ticket_id === "string" ? args.ticket_id : null;
  try {
    db.run(
      "INSERT INTO files (id, filename, content_type, bytes, sha256, created_at, ticket_id, warnings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, filename, contentType, bytes.length, digest, new Date().toISOString(), ticketId, JSON.stringify(warnings)],
    );
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
  return { id, filename, contentType: contentType, bytes: bytes.length, sha256: digest, warnings, sharedFolder: folder };
}

/** The saved files, and the shared folder: its path, and the reason when it cannot be used now. */
export async function list_files(db: Db, args: Record<string, any>, env: NodeJS.ProcessEnv = process.env) {
  let limit = Number.isFinite(args.limit) ? Math.floor(args.limit) : 50;
  limit = Math.min(Math.max(limit, 1), 500);
  const rows = db.all<Row>(
    "SELECT id, filename, content_type, bytes, sha256, created_at FROM files ORDER BY created_at DESC, rowid DESC LIMIT ?",
    [limit],
  );
  const files = rows.map((r) => ({
    id: r.id, filename: r.filename, contentType: r.content_type, bytes: r.bytes, sha256: r.sha256, created_at: r.created_at,
  }));
  const check = checkSharedFolder(env);
  if (check.ok) return { sharedFolder: check.folder, files };
  const problem = check.folder === undefined
    ? `No shared folder is set up yet, so no file can be saved. A person opens **Connectors**, the card **Files**, presses **Edit credentials**, enters the full path under **Shared folder** and saves. ${suggestFolderStep()}`
    : `${check.problem} ${CHANGE_FOLDER_STEP}`;
  return { sharedFolder: check.folder ?? null, sharedFolderProblem: problem, files };
}

/** Same result shape as the ERP connector's get_document. */
export async function get_file(db: Db, args: Record<string, any>, env: NodeJS.ProcessEnv = process.env) {
  if (args.kind !== "file") throw new Error(`Unknown file kind: ${JSON.stringify(args.kind)} — expected "file".`);
  const id = typeof args.id === "string" ? args.id : "";
  const row = /^[0-9a-f-]{36}$/.test(id) ? db.get<Row>("SELECT * FROM files WHERE id = ?", [id]) : undefined;
  if (!row) throw new Error(`Unknown file id: ${JSON.stringify(args.id)}`);
  const buf = fs.readFileSync(path.join(storeDir(env), row.id));
  if (buf.length !== row.bytes || sha256(buf) !== row.sha256) {
    throw new Error("The stored file no longer matches its fingerprint; it is not returned.");
  }
  return { filename: row.filename, contentType: row.content_type, contentBase64: buf.toString("base64"), sha256: row.sha256, warnings: JSON.parse(row.warnings) as string[] };
}
