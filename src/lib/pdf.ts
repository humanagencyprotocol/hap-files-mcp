import { inflateSync, constants } from "node:zlib";
import { Refusal } from "./name.js";

/**
 * Rule 5 (PDF only). Refuse JavaScript / OpenAction scripts and embedded files; warn on forms,
 * annotations and incremental updates. Warnings are fixed sentences written here — nothing
 * from the file is ever copied into them.
 *
 * The whole file is scanned as bytes (stream bodies included, on purpose: a parser trick must not
 * hide a key), after decoding "#xx" escapes in names. Flate streams are inflated and scanned too,
 * because PDF 1.5 object streams hide dictionaries inside compressed data.
 */

const MAX_INFLATE_PER_STREAM = 128 * 1024 * 1024;
const MAX_INFLATE_TOTAL = 256 * 1024 * 1024;
const MAX_STREAMS = 20000;

const refuse = (m: string) => new Refusal(`Refused: ${m}`);

function decodeNameEscapes(s: string): string {
  return s.replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

// A PDF name ends at whitespace or a delimiter.
const END = "(?=[\\s\\0()<>\\[\\]{}/%]|$)";
const tok = (name: string) => new RegExp(`/${name}${END}`);

const SCRIPT = [tok("JavaScript"), tok("JS"), tok("Launch")];
const EMBEDDED = [tok("EmbeddedFile"), tok("EmbeddedFiles"), tok("EF"), tok("FileAttachment")];
const ENCRYPT = tok("Encrypt");
const FORM = [tok("AcroForm"), tok("XFA")];
const ANNOT = tok("Annots");
const OBJSTM = tok("ObjStm");
const LINEARIZED = tok("Linearized");
const SIMPLE_FILTERS = new Set(["FlateDecode", "DCTDecode", "JPXDecode", "CCITTFaxDecode", "JBIG2Decode"]);

function inflateStreams(buf: Buffer): string[] {
  const out: string[] = [];
  let total = 0;
  let count = 0;
  const key = Buffer.from("stream");
  let from = 0;
  for (;;) {
    const i = buf.indexOf(key, from);
    if (i < 0) break;
    from = i + key.length;
    // "stream" must be followed by CRLF or LF, and not be the tail of "endstream".
    if (i >= 3 && buf.toString("latin1", i - 3, i) === "end") continue;
    let start = from;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x0a) start += 1;
    else continue;
    // zlib header: CM=8 and header checksum valid.
    if ((buf[start] & 0x0f) !== 8 || ((buf[start] << 8) | buf[start + 1]) % 31 !== 0) continue;
    if (++count > MAX_STREAMS) throw refuse("this PDF has too many data streams to be checked.");
    try {
      const data = inflateSync(buf.subarray(start), { maxOutputLength: MAX_INFLATE_PER_STREAM, finishFlush: constants.Z_SYNC_FLUSH });
      total += data.length;
      if (total > MAX_INFLATE_TOTAL) throw refuse("this PDF unpacks to too much data to be checked.");
      out.push(data.toString("latin1"));
    } catch (e) {
      if (e instanceof Refusal) throw e;
      if ((e as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") throw refuse("this PDF unpacks to too much data to be checked.");
      // Not a valid zlib stream (or damaged): nothing to scan here.
    }
  }
  return out;
}

const GOTO = new RegExp(`/S\\s*/GoTo${END}`);

/** Index just after the matching ">>" of the dictionary that starts at `at` ("<<"), or -1. */
function dictEnd(t: string, at: number): number {
  let depth = 0;
  for (let i = at; i < t.length - 1; i++) {
    if (t[i] === "<" && t[i + 1] === "<") { depth++; i++; }
    else if (t[i] === ">" && t[i + 1] === ">") { depth--; i++; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Is the value starting at `at` a harmless open action: a destination array, or an action dictionary of type /GoTo? */
function harmlessAction(t: string, at: number, all: string[], depth = 0): boolean {
  const rest = t.slice(at).trimStart();
  const pos = t.length - rest.length;
  if (rest.startsWith("[")) return true;
  if (rest.startsWith("<<")) {
    const end = dictEnd(t, pos);
    return end > 0 && GOTO.test(t.slice(pos, end));
  }
  const ref = /^(\d+)\s+(\d+)\s+R/.exec(rest);
  if (ref && depth < 3) {
    const def = new RegExp(`(?:^|[\\s>\\]])${ref[1]}\\s+${ref[2]}\\s+obj\\b`, "g");
    let found = 0;
    for (const x of all) {
      for (const m of x.matchAll(def)) {
        found++;
        if (!harmlessAction(x, m.index! + m[0].length, all, depth + 1)) return false;
      }
    }
    return found > 0; // not found (e.g. inside an object stream): cannot be verified
  }
  return false;
}

export function checkPdf(bytes: Buffer): string[] {
  const raw = decodeNameEscapes(bytes.toString("latin1"));
  const texts = [raw];

  if (ENCRYPT.test(raw)) throw refuse("this PDF is encrypted, so it cannot be checked.");

  const hasObjStm = OBJSTM.test(raw);
  if (hasObjStm) {
    // Object streams are always plain (non-nested) objects, so their /Filter is visible here.
    for (const m of raw.matchAll(/\/Filter\s*(\[[^\]]*\]|\/[^\s\/\[\]<>()%]+)/g)) {
      for (const n of m[1].matchAll(/\/([^\s\/\[\]<>()%]+)/g)) {
        if (!SIMPLE_FILTERS.has(n[1])) throw refuse("this PDF uses a data encoding that cannot be checked.");
      }
    }
  }
  for (const s of inflateStreams(bytes)) texts.push(decodeNameEscapes(s));

  const any = (res: RegExp[]) => texts.some((t) => res.some((r) => r.test(t)));
  if (any(SCRIPT)) throw refuse("this PDF contains a script (JavaScript or an action that runs on open).");
  for (const t of texts) {
    for (const m of t.matchAll(/\/OpenAction(?=[\s\0()<>\[\]{}\/%]|$)/g)) {
      if (!harmlessAction(t, m.index! + m[0].length, texts)) {
        throw refuse("this PDF contains a script (JavaScript or an action that runs on open).");
      }
    }
  }
  if (any(EMBEDDED)) throw refuse("this PDF contains an embedded file.");

  const warnings: string[] = [];
  if (any(FORM)) warnings.push("This PDF contains form fields.");
  if (texts.some((t) => ANNOT.test(t))) warnings.push("This PDF contains annotations (for example comments or links).");
  const starts = (raw.match(/startxref/g) ?? []).length;
  const linearized = LINEARIZED.test(raw.slice(0, 2048));
  if (starts - (linearized ? 1 : 0) > 1) {
    warnings.push("This PDF was changed after it was first created (incremental updates); earlier content may still be inside the file.");
  }
  return warnings;
}
