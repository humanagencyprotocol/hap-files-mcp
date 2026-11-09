import fs from "node:fs";
import path from "node:path";
import { Refusal } from "./name.js";

export const MAX_BYTES = 25 * 1024 * 1024; // 26214400

/**
 * What protection each platform gets (also in README):
 *  - Final path component: refused if lstat says symlink; opened with O_NOFOLLOW where Node exposes it
 *    (macOS, Linux), so a swap to a symlink between check and open fails at open (ELOOP).
 *    On Windows Node has no O_NOFOLLOW: lstat before, and the handle is compared (dev/ino) with the
 *    path again after opening; a swap in that window is detected only if it changes the file identity.
 *  - The shared folder itself must not be a symlink (lstat), and must resolve to the same real path
 *    after the open. Its own parents may be links (macOS /tmp, /var). Node cannot open relative to a
 *    directory handle (no openat), so a swap of the folder during the call is not prevented by the OS;
 *    it is detected afterwards (Linux: the handle's real path from /proc/self/fd must equal
 *    realpath(folder)/name; all platforms: folder lstat/realpath and the file's dev/ino re-checked).
 *  - Reading happens from the opened handle only. The bytes that are hashed, type-checked and stored
 *    are the bytes read from that handle once.
 *  - O_NONBLOCK keeps a FIFO from blocking the server; a non-regular handle is refused by fstat.
 */

export interface OpenHooks {
  /** Test seam (not reachable over MCP): runs after the file is opened, before it is read. */
  afterOpen?: (folder: string, name: string) => void;
  /** Test seam: runs after every check, immediately before the first read. */
  beforeRead?: (folder: string, name: string) => void;
}

function refuse(message: string): never {
  throw new Refusal(`Refused: ${message}`);
}

/** The shared folder itself must be a real directory, not a link. Its own parents may be links (macOS /tmp, /var). */
function assertFolderNotLink(folder: string) {
  let st: fs.Stats;
  try { st = fs.lstatSync(folder); } catch { refuse("the shared folder does not exist."); }
  if (st.isSymbolicLink()) refuse("the shared folder is a symbolic link.");
  if (!st.isDirectory()) refuse("the shared folder is not a folder.");
}

export interface OpenedFile { bytes: Buffer }

export function readFromSharedFolder(folderSetting: string, name: string, hooks: OpenHooks = {}): OpenedFile {
  if (!path.isAbsolute(folderSetting)) refuse("the shared folder must be set as a full path.");
  const folder = path.resolve(folderSetting);
  assertFolderNotLink(folder);
  const realFolder = fs.realpathSync(folder);

  const full = path.join(folder, name);
  if (path.dirname(full) !== folder) refuse("the file must be directly in the shared folder.");

  let pre: fs.BigIntStats;
  try { pre = fs.lstatSync(full, { bigint: true }); } catch { refuse("no such file in the shared folder."); }
  if (pre.isSymbolicLink()) refuse("the file is a symbolic link.");
  if (!pre.isFile()) refuse("the file is not a regular file.");

  const c = fs.constants;
  const flags = c.O_RDONLY | (c.O_NOFOLLOW ?? 0) | (c.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(full, flags);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") refuse("the file is a symbolic link.");
    if (code === "ENOENT") refuse("no such file in the shared folder.");
    refuse("the file could not be opened.");
  }
  try {
    hooks.afterOpen?.(folder, name);

    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) refuse("the file is not a regular file.");
    if (st.dev !== pre.dev || st.ino !== pre.ino) refuse("the file was replaced while it was being opened.");

    // Inside the folder: Linux can tell us the handle's real path.
    if (process.platform === "linux") {
      let real: string;
      try { real = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { refuse("the file location could not be verified."); }
      if (real !== path.join(realFolder, name)) refuse("the file is not inside the shared folder.");
    }
    // Everywhere: the path still names the same file and the folder was not replaced by a link.
    assertFolderNotLink(folder);
    if (fs.realpathSync(folder) !== realFolder) refuse("the shared folder was replaced while the file was being opened.");
    let post: fs.BigIntStats;
    try { post = fs.lstatSync(full, { bigint: true }); } catch { refuse("the file was removed while it was being opened."); }
    if (post.isSymbolicLink() || post.dev !== st.dev || post.ino !== st.ino) refuse("the file was replaced while it was being opened.");

    if (st.size > BigInt(MAX_BYTES)) refuse("the file is larger than 25 MB.");

    hooks.beforeRead?.(folder, name);

    // Read from the handle only, once. Stop one byte past the limit so a growing file is caught.
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      let n: number;
      try { n = fs.readSync(fd, chunk, 0, chunk.length, null); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue;
        refuse("the file could not be read.");
      }
      if (n === 0) break;
      total += n;
      if (total > MAX_BYTES) refuse("the file is larger than 25 MB.");
      chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
    return { bytes: Buffer.concat(chunks, total) };
  } finally {
    fs.closeSync(fd);
  }
}
