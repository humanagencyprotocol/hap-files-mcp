import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { zlibSync } from "./zlib-helper.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const DIST = path.resolve(__dirname, "../dist/index.js");
export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export interface World {
  root: string; folder: string; dataDir: string; client: Client;
  put(name: string, content: Buffer | string): string;
  call(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any; raw: any }>;
  save(file: unknown): Promise<{ isError: boolean; data: any }>;
  storeFiles(): string[];
  close(): Promise<void>;
}

/**
 * A scratch root for one test, real path. Inside this repo, not the system temp folder: the connector
 * refuses a shared folder there (see src/lib/folder.ts). Gitignored.
 */
export const WORK = path.resolve(__dirname, "../.test-work");
export function scratchRoot(prefix: string): string {
  fs.mkdirSync(WORK, { recursive: true });
  return fs.realpathSync(fs.mkdtempSync(path.join(WORK, prefix)));
}

/** A real MCP server (the built dist/index.js) over stdio, on a real scratch folder (real path, no symlinks above it). */
export async function startWorld(opts: { folder?: boolean } = {}): Promise<World> {
  const root = scratchRoot("files-mcp-");
  const folder = path.join(root, "shared");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(folder);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HAP_DATA_DIR: dataDir };
  if (opts.folder !== false) env.FILES_FOLDER = folder;
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST], env, stderr: "ignore", maxBufferSize: 256 * 1024 * 1024 } as any));
  const call = async (tool: string, args: Record<string, unknown>) => {
    const raw: any = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300000, maxTotalTimeout: 300000 });
    const text = raw.content?.[0]?.text;
    return { isError: !!raw.isError, data: text ? JSON.parse(text) : undefined, raw };
  };
  return {
    root, folder, dataDir, client, call,
    put(name, content) { const p = path.join(folder, name); fs.writeFileSync(p, content); return p; },
    save: (file) => call("save_file", { file }),
    storeFiles() { const d = path.join(dataDir, "files-store"); return fs.existsSync(d) ? fs.readdirSync(d) : []; },
    async close() { await client.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// --- fixtures ---
export const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const png = (n = 64) => Buffer.concat([PNG_HEAD, Buffer.alloc(n, 7)]);
export const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
export const gif = () => Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20, 0)]);
export const webp = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(20)]);
export const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(30)]);
export const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(30)]);
export const mkv = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88]), Buffer.from("matroska"), Buffer.alloc(30)]);

/** A minimal PDF. `catalogExtra` goes into the catalog dictionary, `extraObjects` after the page. */
export function pdf(opts: { catalogExtra?: string; pageExtra?: string; extraObjects?: Buffer | string; tail?: string } = {}): Buffer {
  const head = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${opts.catalogExtra ?? ""} >>\nendobj\n` +
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ${opts.pageExtra ?? ""} >>\nendobj\n`;
  const tail = opts.tail ?? `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(opts.extraObjects ?? "", "latin1"), Buffer.from(tail, "latin1")]);
}

/** A PDF 1.5 style file whose catalog lives inside a compressed object stream. */
export function pdfWithObjStm(catalogBody: string, filter = "/FlateDecode"): Buffer {
  const inner = Buffer.from(`1 0 ${catalogBody}`, "latin1");
  const data = filter === "/FlateDecode" ? zlibSync(inner) : Buffer.from(inner.toString("hex") + ">", "latin1");
  const obj = Buffer.concat([
    Buffer.from(`4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter ${filter} /Length ${data.length} >>\nstream\n`, "latin1"),
    data, Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]);
  return pdf({ extraObjects: obj });
}
