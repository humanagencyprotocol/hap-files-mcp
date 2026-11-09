import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startWorld, type World, sha256, png, jpeg, gif, webp, mp4, webm, mkv, pdf } from "./helpers.js";

let w: World;
beforeAll(async () => { w = await startWorld(); });
afterAll(async () => { await w.close(); });

async function expectRefused(file: unknown, re: RegExp) {
  const before = (await w.call("list_files", {})).data.length;
  const r = await w.save(file);
  expect(r.isError, JSON.stringify(r.data)).toBe(true);
  expect(r.data.error).toMatch(re);
  expect((await w.call("list_files", {})).data.length).toBe(before);
}

describe("tool surface", () => {
  it("save_file's description carries the real folder path", async () => {
    const { tools } = await w.client.listTools();
    expect(tools.find((t) => t.name === "save_file")!.description).toContain(`The shared folder is: ${w.folder}`);
  });
  it("without a folder the description says a person must choose one", async () => {
    const wn = await startWorld({ folder: false });
    try {
      const { tools } = await wn.client.listTools();
      expect(tools.find((t) => t.name === "save_file")!.description).toMatch(/No shared folder is set up yet: a person must choose one/);
    } finally { await wn.close(); }
  });
  it("lists exactly the three tools, get_file has the ERP output shape", async () => {
    const { tools } = await w.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_file", "list_files", "save_file"]);
    const gd: any = tools.find((t) => t.name === "get_file");
    expect(Object.keys(gd.outputSchema.properties)).toEqual(["filename", "contentType", "contentBase64", "sha256", "warnings"]);
    expect(gd.outputSchema.required).toEqual(["filename", "contentType", "contentBase64", "sha256"]);
  });
});

describe("rule 1: bare name", () => {
  it.each([
    ["relative path", "sub/a.png"],
    ["parent traversal path", "../a.png"],
    ["dot-dot", ".."],
    ["dot", "."],
    ["absolute posix path", "/etc/passwd"],
    ["backslash", "sub\\a.png"],
    ["windows absolute", "C:\\x.png"],
    ["NUL", "a\0.png"],
    ["empty", ""],
  ])("refuses %s", async (_n, file) => { await expectRefused(file, /^Refused:/); });
  it("refuses a non-string", async () => { await expectRefused(42, /^Refused:/); await expectRefused(undefined, /^Refused:/); });
  it("a file outside the folder named by absolute path is not read", async () => {
    const outside = path.join(w.root, "outside.png"); fs.writeFileSync(outside, png());
    await expectRefused(outside, /not an absolute path|only the file name/);
    await expectRefused("../outside.png", /only the file name/);
  });
  it("allows a name that merely contains two dots", async () => {
    w.put("report..final.png", png());
    expect((await w.save("report..final.png")).isError).toBe(false);
  });
});

describe("rule 2: symlinks and non-regular files", () => {
  it("refuses a symlink as the file (target inside the folder)", async () => {
    w.put("real.png", png()); fs.symlinkSync(path.join(w.folder, "real.png"), path.join(w.folder, "link.png"));
    await expectRefused("link.png", /symbolic link/);
  });
  it("refuses a symlink as the file (target outside the folder)", async () => {
    const secret = path.join(w.root, "secret.txt"); fs.writeFileSync(secret, "top secret");
    fs.symlinkSync(secret, path.join(w.folder, "innocent.txt"));
    await expectRefused("innocent.txt", /symbolic link/);
  });
  it("refuses a dangling symlink", async () => {
    fs.symlinkSync(path.join(w.root, "nope"), path.join(w.folder, "dangling.txt"));
    await expectRefused("dangling.txt", /symbolic link|no such file/);
  });
  it("refuses when the shared folder itself is a symlink", async () => {
    const real = path.join(w.root, "real-folder"); fs.mkdirSync(real); fs.writeFileSync(path.join(real, "a.png"), png());
    const link = path.join(w.root, "folder-link"); fs.symlinkSync(real, link);
    const w3 = await startWorldWithFolder(link);
    try {
      const r = await w3.call("save_file", { file: "a.png" });
      expect(r.isError).toBe(true); expect(r.data.error).toMatch(/symbolic link/);
      expect(w3.storeFiles()).toEqual([]);
    } finally { await w3.close(); }
  });
  it("allows a shared folder whose own parents are symlinks (macOS /tmp, /var)", async () => {
    const real = path.join(w.root, "parent-real"); fs.mkdirSync(path.join(real, "inner"), { recursive: true });
    fs.writeFileSync(path.join(real, "inner", "a.png"), png());
    const link = path.join(w.root, "parent-link"); fs.symlinkSync(real, link);
    const w3 = await startWorldWithFolder(path.join(link, "inner"));
    try {
      const r = await w3.call("save_file", { file: "a.png" });
      expect(r.isError, JSON.stringify(r.data)).toBe(false);
    } finally { await w3.close(); }
  });
  it("refuses a directory", async () => {
    fs.mkdirSync(path.join(w.folder, "adir.png")); await expectRefused("adir.png", /not a regular file/);
  });
  it("refuses a named pipe without hanging", async () => {
    execFileSync("mkfifo", [path.join(w.folder, "pipe.txt")]);
    await expectRefused("pipe.txt", /not a regular file/);
  });
  it("refuses a file with a second hard link, by either name", async () => {
    w.put("linked.png", png());
    fs.linkSync(path.join(w.folder, "linked.png"), path.join(w.folder, "linked-too.png"));
    await expectRefused("linked.png", /hard link/);
    await expectRefused("linked-too.png", /hard link/);
  });
  it("refuses a hard link to a file outside the folder", async () => {
    const outside = path.join(w.root, "outside-link.png");
    fs.writeFileSync(outside, png(9));
    fs.linkSync(outside, path.join(w.folder, "looks-local.png"));
    await expectRefused("looks-local.png", /hard link/);
  });
  it("saves the file again once the second name is gone", async () => {
    w.put("once.png", png());
    fs.linkSync(path.join(w.folder, "once.png"), path.join(w.folder, "twice.png"));
    await expectRefused("once.png", /hard link/);
    fs.rmSync(path.join(w.folder, "twice.png"));
    const ok = await w.save("once.png");
    expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
  });
  it("refuses a missing file", async () => { await expectRefused("nothing-here.pdf", /no such file/); });
  it("a missing file's refusal names the real folder and the next step", async () => {
    const r = await w.save("nothing-here.pdf");
    expect(r.data.error).toContain(w.folder);
    expect(r.data.error).toMatch(/Write the file into that folder, then call save_file again/);
  });
});

describe("rule 3: size", () => {
  const MAX = 18_000_000;
  it("18,000,000 bytes exactly passes; one byte over is refused and stores nothing", async () => {
    const wz = await startWorld();
    try {
      wz.put("exact.txt", Buffer.alloc(MAX, 0x61));
      const ok = await wz.save("exact.txt");
      expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
      expect(ok.data.bytes).toBe(18_000_000);
      expect(wz.storeFiles().length).toBe(1);
      wz.put("over.txt", Buffer.alloc(MAX + 1, 0x61));
      const bad = await wz.save("over.txt");
      expect(bad.isError).toBe(true); expect(bad.data.error).toMatch(/larger than 18 MB/);
      expect(wz.storeFiles().length).toBe(1);
      expect((await wz.call("list_files", {})).data.length).toBe(1);
    } finally { await wz.close(); }
  });
});

describe("rule 4: type from content", () => {
  it.each([
    ["png", png(), "image/png"], ["jpeg", jpeg(), "image/jpeg"], ["gif", gif(), "image/gif"], ["webp", webp(), "image/webp"],
    ["mp4", mp4(), "video/mp4"], ["webm", webm(), "video/webm"], ["pdf", pdf(), "application/pdf"],
  ])("detects %s from content even when named .dat", async (_n, buf, type) => {
    w.put(`t-${_n}.dat`, buf);
    const r = await w.save(`t-${_n}.dat`);
    expect(r.data.contentType).toBe(type);
  });
  it("png content named .pdf is a png (name never decides)", async () => {
    w.put("looks-like.pdf", png());
    expect((await w.save("looks-like.pdf")).data.contentType).toBe("image/png");
  });
  it("text: .md is markdown, anything else plain", async () => {
    w.put("n.md", "# Hello\nüñí"); w.put("n.txt", "# Hello"); w.put("n.pdf", "just text, called pdf"); w.put("README.MD", "# x");
    expect((await w.save("n.md")).data.contentType).toBe("text/markdown");
    expect((await w.save("n.txt")).data.contentType).toBe("text/plain");
    expect((await w.save("n.pdf")).data.contentType).toBe("text/plain");
    expect((await w.save("README.MD")).data.contentType).toBe("text/markdown");
  });
  it("refuses a renamed .exe (as .pdf and as .txt)", async () => {
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100, 0), Buffer.from("This program cannot be run in DOS mode")]);
    w.put("evil.pdf", exe); w.put("evil.txt", exe);
    await expectRefused("evil.pdf", /not supported/); await expectRefused("evil.txt", /not supported/);
  });
  it("refuses a Mach-O / ELF binary", async () => {
    w.put("elf.txt", Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]));
    await expectRefused("elf.txt", /not supported/);
  });
  it("refuses text with a NUL byte and invalid UTF-8", async () => {
    w.put("nul.txt", Buffer.from("abc\0def")); w.put("latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await expectRefused("nul.txt", /not supported/); await expectRefused("latin1.txt", /not supported/);
  });
  it("refuses an empty file", async () => { w.put("empty.txt", ""); await expectRefused("empty.txt", /empty/); });
  it("refuses Matroska (not WebM)", async () => { w.put("a.webm", mkv()); await expectRefused("a.webm", /not supported/); });

  it("refuses real Word and Excel files (zip containers), named .docx/.xlsx and renamed .pdf", async () => {
    const tmp = path.join(w.root, "zipwork"); fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(tmp, "[Content_Types].xml"), "<Types/>");
    for (const [n, dir] of [["doc.docx", "word"], ["sheet.xlsx", "xl"]]) {
      fs.mkdirSync(path.join(tmp, dir), { recursive: true }); fs.writeFileSync(path.join(tmp, dir, "main.xml"), "<x/>");
      const out = path.join(w.folder, n);
      execFileSync("zip", ["-q", "-r", out, "[Content_Types].xml", dir], { cwd: tmp });
      fs.copyFileSync(out, path.join(w.folder, `${n}.pdf`));
      await expectRefused(n, /Word and Excel/); await expectRefused(`${n}.pdf`, /Word and Excel/);
    }
  });
  it("refuses a plain zip", async () => {
    execFileSync("zip", ["-q", path.join(w.folder, "a.zip"), "n.txt"], { cwd: w.folder });
    await expectRefused("a.zip", /zip-based/);
  });
  it("refuses an old OLE (.doc/.xls) file", async () => {
    w.put("old.doc", Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)]));
    await expectRefused("old.doc", /old Word and Excel/);
  });
  it.each([
    ["svg", '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ["svg bare", '  \n<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>'],
    ["html doctype", "<!DOCTYPE html><html><body>hi</body></html>"],
    ["html bare", "<html><body>hi</body></html>"],
    ["html script", "<script>alert(1)</script>"],
    ["html with BOM", "\uFEFF<HTML><BODY>x"],
    ["xml", '<?xml version="1.0"?><a/>'],
  ])("refuses %s (named .txt, .png and .md)", async (n, content) => {
    for (const ext of ["txt", "png", "md"]) {
      w.put(`m-${n.replace(/ /g, "_")}.${ext}`, content);
      await expectRefused(`m-${n.replace(/ /g, "_")}.${ext}`, /HTML, SVG and XML/);
    }
  });
  it("Markdown with inline HTML passes as Markdown; plain text starting with a tag passes as text", async () => {
    w.put("inline.md", "<div align=\"center\">\n\n# Title\n\n</div>\n\n<img src=\"x.png\"> and <b>bold</b>");
    w.put("tag.txt", "<b>bold</b> text");
    expect((await w.save("inline.md")).data.contentType).toBe("text/markdown");
    expect((await w.save("tag.txt")).data.contentType).toBe("text/plain");
  });
  it("refuses an HTML file hidden behind a leading comment", async () => {
    w.put("c.md", "<!-- hi -->\n<html><body>x</body></html>");
    await expectRefused("c.md", /HTML, SVG and XML/);
  });
  it("still accepts text that merely mentions markup later on", async () => {
    w.put("mention.md", "Use the <svg> element carefully.");
    expect((await w.save("mention.md")).isError).toBe(false);
  });
});

describe("file name filtering", () => {
  it("removes control characters and bidi marks", async () => {
    w.put("a\u0007b\nc\u202Ed\u200Fe.txt", "x");
    const r = await w.save("a\u0007b\nc\u202Ed\u200Fe.txt");
    expect(r.data.filename).toBe("abcde.txt");
  });
  it("limits to 200 characters", async () => {
    const n = "x".repeat(240) + ".txt"; w.put(n, "x");
    const r = await w.save(n);
    expect([...r.data.filename].length).toBe(200);
  });
  it("refuses a name that is empty after filtering, and stores nothing", async () => {
    w.put("\u202E\u202D", "x");
    await expectRefused("\u202E\u202D", /empty after/);
  });
});

describe("rule 6: store and immutability", () => {
  it("result shape, fingerprint of exactly the file bytes, readable-only copy", async () => {
    const buf = png(1000); w.put("shape.png", buf);
    const r = await w.save("shape.png");
    expect(Object.keys(r.data).sort()).toEqual(["bytes", "contentType", "filename", "id", "sha256", "warnings"]);
    expect(r.data.sha256).toBe(sha256(buf)); expect(r.data.bytes).toBe(buf.length); expect(r.data.warnings).toEqual([]);
    const stored = path.join(w.dataDir, "files-store", r.data.id);
    expect(fs.readFileSync(stored).equals(buf)).toBe(true);
    expect(fs.statSync(stored).mode & 0o222).toBe(0);
  });
  it("same bytes twice get two ids; changing the source later changes nothing", async () => {
    const buf = png(333); w.put("twice.png", buf);
    const a = await w.save("twice.png"); const b = await w.save("twice.png");
    expect(a.data.id).not.toBe(b.data.id); expect(a.data.sha256).toBe(b.data.sha256);
    fs.writeFileSync(path.join(w.folder, "twice.png"), png(5));
    const g = await w.call("get_file", { kind: "file", id: a.data.id });
    expect(Buffer.from(g.data.contentBase64, "base64").equals(buf)).toBe(true);
    expect(g.data.sha256).toBe(sha256(buf));
  });
  it("a stored copy that was tampered with is not returned", async () => {
    w.put("tamper.png", png(50)); const r = await w.save("tamper.png");
    const stored = path.join(w.dataDir, "files-store", r.data.id);
    expect(() => fs.openSync(stored, "r+")).toThrow(); // read-only
    fs.chmodSync(stored, 0o644); fs.appendFileSync(stored, "x");
    const g = await w.call("get_file", { kind: "file", id: r.data.id });
    expect(g.isError).toBe(true); expect(g.data.error).toMatch(/fingerprint/);
  });
  it("the index refuses UPDATE and DELETE", async () => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path.join(w.dataDir, "files.db"));
    expect(() => db.prepare("UPDATE files SET sha256 = 'x'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM files").run()).toThrow(/immutable/);
    db.close();
  });
  it("there is no tool that changes or deletes a file", async () => {
    const { tools } = await w.client.listTools();
    expect(tools.map((t) => t.name).some((n) => /update|delete|remove|overwrite/.test(n))).toBe(false);
  });
});

describe("list_files and get_file", () => {
  it("lists newest first with the contract fields and honours limit", async () => {
    const all = (await w.call("list_files", {})).data;
    expect(all.length).toBeGreaterThan(3);
    expect(Object.keys(all[0]).sort()).toEqual(["bytes", "contentType", "created_at", "filename", "id", "sha256"]);
    const dates = all.map((d: any) => d.created_at); expect([...dates].sort().reverse()).toEqual(dates);
    expect((await w.call("list_files", { limit: 2 })).data.length).toBe(2);
  });
  it("get_file returns the ERP shape; refuses unknown kind and id", async () => {
    w.put("fresh.png", png(77)); const id = (await w.save("fresh.png")).data.id;
    const g = await w.call("get_file", { kind: "file", id });
    expect(Object.keys(g.data).sort()).toEqual(["contentBase64", "contentType", "filename", "sha256", "warnings"]);
    expect(g.data.warnings).toEqual([]);
    expect(g.raw.structuredContent).toEqual(g.data);
    expect((await w.call("get_file", { kind: "invoice-pdf", id })).isError).toBe(true);
    expect((await w.call("get_file", { kind: "file", id: "../../etc/passwd" })).isError).toBe(true);
    expect((await w.call("get_file", { kind: "file", id: "00000000-0000-0000-0000-000000000000" })).isError).toBe(true);
  });
});

describe("no shared folder set", () => {
  it("save_file refuses with a plain message; list and get still work", async () => {
    const wn = await startWorld({ folder: false });
    try {
      const r = await wn.save("a.png");
      expect(r.isError).toBe(true); expect(r.data.error).toMatch(/no shared folder is set up/);
      expect((await wn.call("list_files", {})).data).toEqual([]);
      expect((await wn.call("get_file", { kind: "file", id: "x" })).isError).toBe(true);
    } finally { await wn.close(); }
  });
});

import fsx from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DIST } from "./helpers.js";
async function startWorldWithFolder(folder: string) {
  const dataDir = fsx.mkdtempSync(path.join(fsx.realpathSync(w.root), "data-"));
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST], env: { PATH: process.env.PATH ?? "", HAP_DATA_DIR: dataDir, FILES_FOLDER: folder }, stderr: "ignore" }));
  return {
    async call(tool: string, args: Record<string, unknown>) {
      const raw: any = await client.callTool({ name: tool, arguments: args });
      return { isError: !!raw.isError, data: JSON.parse(raw.content[0].text) };
    },
    storeFiles: () => (fsx.existsSync(path.join(dataDir, "files-store")) ? fsx.readdirSync(path.join(dataDir, "files-store")) : []),
    close: () => client.close(),
  };
}
