import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Can the connector use the shared folder? Checked when the connector starts (the gateway restarts it
 * when a person saves the folder), when the tools are listed, and before every save and list.
 *
 * The check does what the connector needs and nothing else: it writes a small file, reads it back and
 * deletes it. No list of protected folders: the operating system answers. On a Mac, privacy protection
 * refuses a background program in Documents, Desktop, Downloads and iCloud Drive ("Operation not
 * permitted"); on Linux and Windows plain permissions (and on Windows, Controlled folder access) refuse
 * the same way. Only temporary system folders are refused by name: other programs read them and the
 * computer empties them.
 */
export type FolderCheck =
  | { ok: true; folder: string }
  | { ok: false; folder: string | undefined; problem: string };

/** A folder directly in the home folder: what every text suggests. */
export function suggestedFolder(): string {
  return path.join(os.homedir(), "suveren-files");
}

const OS_WORDS: Record<string, string> = {
  EPERM: "Operation not permitted",
  EACCES: "Permission denied",
  EROFS: "Read-only file system",
};
const BLOCKED = new Set(Object.keys(OS_WORDS));

/** The operating system's own words for an error code, e.g. "Operation not permitted". */
export function osWords(code: string | undefined): string {
  return (code && OS_WORDS[code]) || code || "unknown error";
}

export function isBlocked(code: string | undefined): boolean {
  return !!code && BLOCKED.has(code);
}

const caseFolds = () => process.platform === "darwin" || process.platform === "win32";

function inside(child: string, parent: string): boolean {
  const c = caseFolds() ? child.toLowerCase() : child;
  const p = caseFolds() ? parent.toLowerCase() : parent;
  const rel = path.relative(p, c);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The system's temporary folders, as given and as real paths (macOS /tmp is /private/tmp). */
export function tempRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = new Set<string>();
  const home = path.resolve(os.homedir());
  const add = (p: string | undefined) => {
    if (!p || !path.isAbsolute(p)) return;
    for (const candidate of [path.resolve(p), (() => { try { return fs.realpathSync(p); } catch { return null; } })()]) {
      if (!candidate) continue;
      // A temp setting that is a whole disk or contains the home folder would refuse everything.
      if (path.parse(candidate).root === candidate || inside(home, candidate)) continue;
      roots.add(candidate);
    }
  };
  add(os.tmpdir());
  add(env.TMPDIR); add(env.TEMP); add(env.TMP);
  if (process.platform === "win32") {
    add(path.join(env.SystemRoot || env.windir || "C:\\Windows", "Temp"));
  } else {
    for (const p of ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders", "/dev/shm"]) add(p);
  }
  return [...roots];
}

function cannotUse(folder: string, why: string): string {
  return `The Files connector cannot use ${folder}: ${why}`;
}

/** The plain reason for a folder this computer does not let the connector use. */
export function blockedReason(folder: string, code: string | undefined): string {
  const choose = `choose a folder directly in your home folder, such as ${suggestedFolder()}.`;
  const next = process.platform === "darwin"
    ? ` On a Mac, Documents, Desktop, Downloads and iCloud Drive are protected; ${choose}`
    : ` ${choose[0].toUpperCase()}${choose.slice(1)}`;
  return cannotUse(folder, `this computer does not allow it to read or write there (${osWords(code)}).${next}`);
}

/** Checks the folder setting. Never throws. */
export function checkSharedFolder(env: NodeJS.ProcessEnv = process.env): FolderCheck {
  const setting = env.FILES_FOLDER;
  if (!setting) return { ok: false, folder: undefined, problem: "No shared folder is set up yet." };
  if (!path.isAbsolute(setting)) {
    return { ok: false, folder: setting, problem: cannotUse(setting, `it is not a full path. Enter the full path, such as ${suggestedFolder()}.`) };
  }
  const folder = path.resolve(setting);
  let real: string | null = null;
  try { real = fs.realpathSync(folder); } catch { /* reported below */ }
  const roots = tempRoots(env);
  if ([folder, real].some((p) => p && roots.some((t) => inside(p, t)))) {
    return {
      ok: false, folder,
      problem: cannotUse(folder, `it is a temporary system folder. Other programs can read it, and the computer empties it. Choose a folder directly in your home folder, such as ${suggestedFolder()}.`),
    };
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(folder);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (isBlocked(code)) return { ok: false, folder, problem: blockedReason(folder, code) };
    return { ok: false, folder, problem: cannotUse(folder, `the folder does not exist. Create it, or choose another folder, such as ${suggestedFolder()}.`) };
  }
  if (st.isSymbolicLink()) return { ok: false, folder, problem: cannotUse(folder, "it is a symbolic link. Enter the folder's real path.") };
  if (!st.isDirectory()) return { ok: false, folder, problem: cannotUse(folder, "it is not a folder.") };

  // Write, read back, delete: what the AI and the connector will do there.
  const probe = path.join(folder, `.suveren-files-check-${randomBytes(6).toString("hex")}`);
  const marker = Buffer.from(`suveren files check ${Date.now()}\n`);
  let created = false;
  try {
    const fd = fs.openSync(probe, "wx", 0o600);
    created = true;
    try { fs.writeSync(fd, marker); } finally { fs.closeSync(fd); }
    if (!fs.readFileSync(probe).equals(marker)) {
      return { ok: false, folder, problem: cannotUse(folder, "a test file written there did not read back the same.") };
    }
    fs.unlinkSync(probe);
    created = false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (isBlocked(code)) return { ok: false, folder, problem: blockedReason(folder, code) };
    return { ok: false, folder, problem: cannotUse(folder, `a test file could not be written, read back and deleted there (${osWords(code)}).`) };
  } finally {
    if (created) { try { fs.unlinkSync(probe); } catch { /* the reason above already says what failed */ } }
  }
  return { ok: true, folder };
}

/** What the AI does next when the folder cannot be used. */
export const CHANGE_FOLDER_STEP =
  "No file can be saved until a person chooses another folder: they open **Connectors**, the card **Files**, press " +
  "**Edit credentials**, enter the full path under **Shared folder** and save. Tell the person this reason in plain words. " +
  "Do not copy files to another folder and do not try another way.";

/** The folder to suggest when none is set: directly in the home folder, never Documents. */
export function suggestFolderStep(): string {
  return `Suggest a folder directly in their home folder (for example ${suggestedFolder()}; not in Documents, Desktop or Downloads, ` +
    "which a Mac does not let the connector read) and give the person its exact full path to type; the folder must exist.";
}
