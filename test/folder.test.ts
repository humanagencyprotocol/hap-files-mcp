/**
 * The shared folder check: a folder this computer does not let the connector use, a temporary system
 * folder, and the three file refusals ("not permitted", "no such file", "not inside the folder").
 * Real permission bits (chmod 000), the real built server over stdio; nothing is mocked.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DIST, png, scratchRoot } from "./helpers.js";
import { checkSharedFolder, suggestedFolder } from "../src/lib/folder.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0; // root ignores permission bits
const posix = process.platform !== "win32";
const permissionsWork = posix && !isRoot;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) { fixPerms(r); fs.rmSync(r, { recursive: true, force: true }); }
});
function fixPerms(dir: string) {
  try { fs.chmodSync(dir, 0o700); } catch { return; }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) fixPerms(p); else { try { fs.chmodSync(p, 0o600); } catch { /* link */ } }
  }
}

function root(prefix: string) { const r = scratchRoot(prefix); roots.push(r); return r; }

/** The built server with this folder setting; its start-up log is kept. */
async function start(folder: string | undefined) {
  const dataDir = path.join(root("data-"), "data");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HAP_DATA_DIR: dataDir, HOME: os.homedir() };
  if (folder !== undefined) env.FILES_FOLDER = folder;
  const transport = new StdioClientTransport({ command: process.execPath, args: [DIST], env, stderr: "pipe" });
  let log = "";
  transport.stderr?.on("data", (d: Buffer) => { log += d.toString(); });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(transport);
  const call = async (tool: string, args: Record<string, unknown>) => {
    const raw: any = await client.callTool({ name: tool, arguments: args });
    return { isError: !!raw.isError, data: JSON.parse(raw.content[0].text) };
  };
  const description = async () => (await client.listTools()).tools.find((t) => t.name === "save_file")!.description!;
  const store = () => (fs.existsSync(path.join(dataDir, "files-store")) ? fs.readdirSync(path.join(dataDir, "files-store")) : []);
  // Give the start-up log a moment to arrive.
  await new Promise((r) => setTimeout(r, 200));
  return { call, description, store, log: () => log, close: () => client.close() };
}

const CHANGE_STEP = /\*\*Connectors\*\*, the card \*\*Files\*\*, press \*\*Edit credentials\*\*.*\*\*Shared folder\*\*/s;
const NO_WORKAROUND = /Do not copy files to another folder/;
const leftovers = (folder: string) => fs.readdirSync(folder).filter((n) => n.startsWith(".suveren-files-check-"));

describe("a folder this computer does not let the connector use (chmod 000)", () => {
  it.skipIf(!permissionsWork)("start, description, save and list all give the plain reason; nothing is stored", async () => {
    const folder = path.join(root("blocked-"), "shared");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "a.png"), png());
    fs.chmodSync(folder, 0o000);
    const s = await start(folder);
    try {
      const reason = `The Files connector cannot use ${folder}: this computer does not allow it to read or write there (Permission denied).`;
      // At start (the gateway restarts the connector when a person saves the folder).
      expect(s.log()).toContain(reason);
      // What the AI is told before it tries.
      const d = await s.description();
      expect(d).toContain(reason);
      expect(d).toContain(`choose a folder directly in your home folder, such as ${suggestedFolder()}`.replace(/^c/, process.platform === "darwin" ? "c" : "C"));
      expect(d).toMatch(CHANGE_STEP);
      expect(d).toMatch(NO_WORKAROUND);
      expect(d).not.toMatch(/write the file there first/);
      // The refusal: the reason, the folder, the next step; never "could not be opened".
      const r = await s.call("save_file", { file: "a.png" });
      expect(r.isError).toBe(true);
      expect(r.data.error).toContain(reason);
      expect(r.data.error).toMatch(CHANGE_STEP);
      expect(r.data.error).not.toMatch(/could not be opened/);
      // The gateway shows a person the first 500 characters of a refusal: the reason and the suggested folder fit.
      expect(r.data.error.slice(0, 500)).toContain(suggestedFolder());
      expect(s.store()).toEqual([]);
      // list_files still lists, and names the folder and the problem.
      const l = await s.call("list_files", {});
      expect(l.isError).toBe(false);
      expect(l.data.sharedFolder).toBe(folder);
      expect(l.data.sharedFolderProblem).toContain(reason);
      expect(l.data.files).toEqual([]);
    } finally { await s.close(); fs.chmodSync(folder, 0o700); }
  });

  it.skipIf(!permissionsWork || process.platform !== "darwin")("on a Mac the reason names the protected folders", async () => {
    const folder = path.join(root("blocked-mac-"), "shared");
    fs.mkdirSync(folder); fs.chmodSync(folder, 0o000);
    const s = await start(folder);
    try {
      expect((await s.call("save_file", { file: "a.png" })).data.error)
        .toContain(`On a Mac, Documents, Desktop, Downloads and iCloud Drive are protected; choose a folder directly in your home folder, such as ${suggestedFolder()}.`);
    } finally { await s.close(); fs.chmodSync(folder, 0o700); }
  });

  it.skipIf(!permissionsWork)("read-only folder (chmod 500): the write fails, the reason says so", async () => {
    const folder = path.join(root("readonly-"), "shared");
    fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, "a.png"), png()); fs.chmodSync(folder, 0o500);
    const s = await start(folder);
    try {
      const r = await s.call("save_file", { file: "a.png" });
      expect(r.isError).toBe(true);
      expect(r.data.error).toContain(`The Files connector cannot use ${folder}: this computer does not allow it to read or write there (Permission denied).`);
      expect(s.store()).toEqual([]);
    } finally { await s.close(); fs.chmodSync(folder, 0o700); }
  });

  it.skipIf(!permissionsWork)("a folder that becomes blocked after start is refused at the next save", async () => {
    const folder = path.join(root("later-"), "shared");
    fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, "a.png"), png());
    const s = await start(folder);
    try {
      expect(await s.description()).toContain(`The shared folder is: ${folder}`);
      fs.chmodSync(folder, 0o000);
      const r = await s.call("save_file", { file: "a.png" });
      expect(r.isError).toBe(true);
      expect(r.data.error).toContain("does not allow it to read or write there (Permission denied)");
    } finally { await s.close(); fs.chmodSync(folder, 0o700); }
  });
});

describe("a temporary system folder is refused", () => {
  const TEMP_REASON = /it is a temporary system folder\. Other programs can read it, and the computer empties it\. Choose a folder directly in your home folder, such as /;

  it("the OS temp folder (real path)", async () => {
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "files-mcp-temp-")));
    roots.push(folder);
    fs.writeFileSync(path.join(folder, "a.png"), png());
    const s = await start(folder);
    try {
      expect(s.log()).toMatch(TEMP_REASON);
      expect(await s.description()).toMatch(TEMP_REASON);
      const r = await s.call("save_file", { file: "a.png" });
      expect(r.isError).toBe(true);
      expect(r.data.error).toContain(`The Files connector cannot use ${folder}: `);
      expect(r.data.error).toMatch(TEMP_REASON);
      expect(s.store()).toEqual([]);
      expect(leftovers(folder)).toEqual([]);
    } finally { await s.close(); }
  });

  it.skipIf(!posix)("/tmp and its real path, the way the AI suggested it", async () => {
    const real = fs.realpathSync("/tmp");
    for (const base of ["/tmp", real]) {
      const folder = fs.mkdtempSync(path.join(base, "files-mcp-tmp-"));
      roots.push(folder);
      const c = checkSharedFolder({ FILES_FOLDER: folder });
      expect(c.ok, folder).toBe(false);
      expect(!c.ok && c.problem).toMatch(TEMP_REASON);
    }
  });

  it.skipIf(process.platform !== "darwin")("macOS /var/folders and /private/var/folders", () => {
    for (const p of ["/var/folders/xy/abc/T/suveren-files", "/private/var/folders/xy/abc/T/suveren-files", "/private/tmp/suveren-files"]) {
      const c = checkSharedFolder({ FILES_FOLDER: p });
      expect(!c.ok && c.problem, p).toMatch(TEMP_REASON);
    }
  });

  it("a TMPDIR set to a whole disk or a home parent does not refuse every folder", () => {
    const folder = path.join(root("tmpdir-guard-"), "shared");
    fs.mkdirSync(folder);
    expect(checkSharedFolder({ FILES_FOLDER: folder, TMPDIR: path.parse(folder).root }).ok).toBe(true);
    expect(checkSharedFolder({ FILES_FOLDER: folder, TMPDIR: path.dirname(os.homedir()) }).ok).toBe(true);
  });
});

describe("a usable folder", () => {
  it("the check leaves nothing behind; save and list answers name the folder", async () => {
    const folder = path.join(root("good-"), "shared");
    fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, "a.png"), png());
    const s = await start(folder);
    try {
      expect(s.log()).toContain(`shared folder ${folder}: usable`);
      const r = await s.call("save_file", { file: "a.png" });
      expect(r.isError, JSON.stringify(r.data)).toBe(false);
      expect(r.data.sharedFolder).toBe(folder);
      const l = await s.call("list_files", {});
      expect(l.data.sharedFolder).toBe(folder);
      expect(l.data.sharedFolderProblem).toBeUndefined();
      expect(l.data.files.map((f: any) => f.id)).toEqual([r.data.id]);
      expect(leftovers(folder)).toEqual([]);
    } finally { await s.close(); }
  });

  it("other folder problems: missing, not a full path, a file instead of a folder", async () => {
    const base = root("other-");
    const missing = path.join(base, "nope");
    expect(!checkSharedFolder({ FILES_FOLDER: missing }).ok && (checkSharedFolder({ FILES_FOLDER: missing }) as any).problem)
      .toBe(`The Files connector cannot use ${missing}: the folder does not exist. Create it, or choose another folder, such as ${suggestedFolder()}.`);
    expect((checkSharedFolder({ FILES_FOLDER: "suveren-files" }) as any).problem).toMatch(/cannot use suveren-files: it is not a full path/);
    fs.writeFileSync(path.join(base, "file"), "x");
    expect((checkSharedFolder({ FILES_FOLDER: path.join(base, "file") }) as any).problem).toMatch(/it is not a folder\./);
  });

  it("the no-folder texts suggest a folder directly in the home folder, never Documents as the place", async () => {
    const s = await start(undefined);
    try {
      const d = await s.description();
      expect(d).toContain(`Suggest a folder directly in their home folder (for example ${suggestedFolder()}; not in Documents`);
      const r = await s.call("save_file", { file: "a.png" });
      expect(r.data.error).toContain(`for example ${suggestedFolder()}`);
      const l = await s.call("list_files", {});
      expect(l.data.sharedFolder).toBeNull();
      expect(l.data.sharedFolderProblem).toMatch(/No shared folder is set up yet/);
    } finally { await s.close(); }
  });
});

describe("the three file refusals each name the folder and the next step", () => {
  it.skipIf(!permissionsWork)("not permitted: the file itself may not be read (chmod 000)", async () => {
    const folder = path.join(root("file-blocked-"), "shared");
    fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, "locked.png"), png()); fs.chmodSync(path.join(folder, "locked.png"), 0o000);
    const s = await start(folder);
    try {
      const r = await s.call("save_file", { file: "locked.png" });
      expect(r.isError).toBe(true);
      expect(r.data.error).toBe(`Refused: the file "locked.png" is in the shared folder ${folder}, but this computer does not allow the Files connector to read it (Permission denied). Write a new copy of the file into the folder, or ask the person to allow reading it, then call save_file again.`);
      expect(s.store()).toEqual([]);
    } finally { await s.close(); }
  });

  it("no such file in the folder", async () => {
    const folder = path.join(root("nofile-"), "shared"); fs.mkdirSync(folder);
    const s = await start(folder);
    try {
      expect((await s.call("save_file", { file: "missing.pdf" })).data.error)
        .toBe(`Refused: no such file "missing.pdf" in the shared folder (${folder}). Write the file into that folder, then call save_file again with its plain name.`);
    } finally { await s.close(); }
  });

  it("not inside the folder: a path, relative or absolute", async () => {
    const folder = path.join(root("outside-"), "shared"); fs.mkdirSync(folder);
    const s = await start(folder);
    try {
      const step = `The file must be directly in the shared folder ${folder}; a file anywhere else is not read. Write the file into that folder first, then call save_file again with its plain name.`;
      expect((await s.call("save_file", { file: "/private/tmp/a.pdf" })).data.error).toBe(`Refused: give only the file name, not an absolute path. ${step}`);
      expect((await s.call("save_file", { file: "../a.pdf" })).data.error).toBe(`Refused: give only the file name, not a path. ${step}`);
    } finally { await s.close(); }
  });

  it("any other refusal also names the folder", async () => {
    const folder = path.join(root("other-refusal-"), "shared"); fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "empty.txt"), "");
    const s = await start(folder);
    try {
      expect((await s.call("save_file", { file: "empty.txt" })).data.error).toBe(`Refused: the file is empty. The shared folder is ${folder}.`);
    } finally { await s.close(); }
  });
});
