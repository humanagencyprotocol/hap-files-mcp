import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, type Db } from "../src/db.js";
import { save_file } from "../src/tools/files.js";
import { png, scratchRoot } from "./helpers.js";

let root: string, folder: string, data: string, db: Db, env: NodeJS.ProcessEnv;
const secret = Buffer.concat([png(10), Buffer.from("SECRET-OUTSIDE-THE-FOLDER")]);
const original = png(500);

beforeEach(async () => {
  root = scratchRoot("docs-race-");
  folder = path.join(root, "shared"); data = path.join(root, "data"); fs.mkdirSync(folder);
  env = { HAP_DATA_DIR: data, FILES_FOLDER: folder };
  db = await createDb(env);
  fs.writeFileSync(path.join(root, "secret.png"), secret);
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const storedBlobs = () => !fs.existsSync(path.join(data, "files-store")) ? [] : fs.readdirSync(path.join(data, "files-store")).map((f) => fs.readFileSync(path.join(data, "files-store", f)));

describe("a hard link on the opened handle", () => {
  it("a second name created after open, before the handle is checked: refused, nothing stored", async () => {
    fs.writeFileSync(path.join(folder, "h.png"), original);
    await expect(save_file(db, { file: "h.png" }, env, {
      afterOpen: (f, n) => { fs.linkSync(path.join(f, n), path.join(root, "second-name.png")); },
    })).rejects.toThrow(/hard link/);
    expect(storedBlobs().length).toBe(0);
  });
});

describe("swap during the call (deterministic: between open and read)", () => {
  it("path swapped for a symlink to a secret after ALL checks, before the read: bytes come from the opened handle", async () => {
    fs.writeFileSync(path.join(folder, "h.png"), original);
    const r = await save_file(db, { file: "h.png" }, env, {
      beforeRead: (f, n) => { fs.rmSync(path.join(f, n)); fs.symlinkSync(path.join(root, "secret.png"), path.join(f, n)); },
    });
    expect(storedBlobs().length).toBe(1);
    expect(storedBlobs()[0].equals(original)).toBe(true);
    expect(r.bytes).toBe(original.length);
  });
  it("file replaced by a symlink to a secret AFTER open: the stored bytes are still the opened file's", async () => {
    fs.writeFileSync(path.join(folder, "a.png"), original);
    const r = await save_file(db, { file: "a.png" }, env, {
      afterOpen: (f, n) => {
        fs.rmSync(path.join(f, n));
        fs.symlinkSync(path.join(root, "secret.png"), path.join(f, n));
      },
    }).then((x) => ({ ok: true as const, x }), (e) => ({ ok: false as const, e: String(e.message) }));
    // Either outcome is safe; what must never happen is that secret bytes get stored.
    for (const b of storedBlobs()) expect(b.includes("SECRET-OUTSIDE")).toBe(false);
    if (r.ok) expect(storedBlobs()[0].equals(original)).toBe(true);
    else expect(r.e).toMatch(/replaced|symbolic|not inside/);
  });
  it("file replaced by a DIFFERENT regular file after open: refused as replaced, nothing stored", async () => {
    fs.writeFileSync(path.join(folder, "b.png"), original);
    await expect(save_file(db, { file: "b.png" }, env, {
      afterOpen: (f, n) => { fs.rmSync(path.join(f, n)); fs.writeFileSync(path.join(f, n), secret); },
    })).rejects.toThrow(/replaced|not inside/);
    expect(fs.existsSync(path.join(data, "files-store"))).toBe(false);
  });
  it("shared folder swapped for a symlink to another directory after open: refused", async () => {
    fs.writeFileSync(path.join(folder, "c.png"), original);
    const other = path.join(root, "other"); fs.mkdirSync(other); fs.writeFileSync(path.join(other, "c.png"), secret);
    await expect(save_file(db, { file: "c.png" }, env, {
      afterOpen: (f) => { fs.renameSync(f, f + ".moved"); fs.symlinkSync(other, f); },
    })).rejects.toThrow(/symbolic link|replaced|not inside/);
    expect(fs.existsSync(path.join(data, "files-store"))).toBe(false);
  });
});

describe("swap during the call (real race: a second process flips the path while calls run)", () => {
  it("never stores bytes from the symlink target; every success equals the original", async () => {
    const target = path.join(folder, "r.png");
    fs.writeFileSync(path.join(root, "orig.png"), original);
    fs.writeFileSync(target, original);
    const { spawn } = await import("node:child_process");
    const flipper = spawn(process.execPath, ["-e", `
      const fs=require("fs");const t=${JSON.stringify(target)},o=${JSON.stringify(path.join(root, "orig.png"))},s=${JSON.stringify(path.join(root, "secret.png"))};
      let i=0;setInterval(()=>{},1000);
      (function loop(){ for(let k=0;k<200;k++){ try{fs.rmSync(t);}catch{} try{ if(i++%2) fs.symlinkSync(s,t); else fs.copyFileSync(o,t);}catch{} } setImmediate(loop); })();
    `], { stdio: "ignore" });
    let ok = 0, refused = 0;
    try {
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        try { await save_file(db, { file: "r.png" }, env); ok++; } catch { refused++; }
      }
    } finally { flipper.kill("SIGKILL"); }
    const blobs = storedBlobs();
    expect(blobs.length).toBe(ok);
    for (const b of blobs) { expect(b.includes("SECRET-OUTSIDE")).toBe(false); expect(b.equals(original)).toBe(true); }
    expect(ok + refused).toBeGreaterThan(50);
    console.log(`race: ${ok} saved (all original bytes), ${refused} refused, 0 secret`);
  });
});
