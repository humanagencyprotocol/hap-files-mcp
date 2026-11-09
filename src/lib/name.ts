import path from "node:path";

export class Refusal extends Error {}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Rule 1: `file` is a bare name. Returns the name unchanged, or throws a plain refusal. */
export function requireBareName(file: unknown, platform: NodeJS.Platform = process.platform): string {
  if (typeof file !== "string" || file.length === 0) {
    throw new Refusal("Refused: give the file name as plain text, for example \"report.pdf\".");
  }
  if (file.includes("\0")) throw new Refusal("Refused: the file name contains a NUL character.");
  if (file.includes("/") || file.includes("\\")) {
    throw new Refusal("Refused: give only the file name, not a path. The file must be in the shared folder.");
  }
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) {
    throw new Refusal("Refused: give only the file name, not an absolute path.");
  }
  if (file === "." || file === "..") {
    throw new Refusal("Refused: \"..\" and \".\" are not file names.");
  }
  if (file.length > 255) throw new Refusal("Refused: the file name is too long.");
  if (platform === "win32") {
    if (file.includes(":") || /[<>"|?*]/.test(file) || /[. ]$/.test(file) || WINDOWS_RESERVED.test(file)) {
      throw new Refusal("Refused: this file name is not allowed on Windows.");
    }
  }
  return file;
}

// Control characters (Cc) and bidirectional marks / isolates / embeddings.
const FILTERED = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;

/** The name as stored and shown: control characters and bidi marks removed, at most 200 characters. */
export function filterFilename(name: string): string {
  const cleaned = [...name.replace(FILTERED, "")].slice(0, 200).join("");
  if (cleaned.length === 0) throw new Refusal("Refused: the file name is empty after removing control characters.");
  return cleaned;
}
