/** Rule 4: the type comes from the file's CONTENT. Never from the name or the AI (the name only splits markdown from plain text). */

export const ALLOWED_TYPES = [
  "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif",
  "video/mp4", "video/webm", "text/markdown", "text/plain",
] as const;
export type AllowedType = (typeof ALLOWED_TYPES)[number];

export type Detection = { ok: true; contentType: AllowedType } | { ok: false; message: string };

const NOT_SUPPORTED = "Refused: this file type is not supported. Allowed: PDF, PNG, JPEG, WebP, GIF, MP4, WebM, Markdown and plain text.";

const startsWith = (b: Buffer, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString("latin1");

const MP4_BRANDS = new Set([
  "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "msnv", "mmp4", "M4V ", "M4VH", "M4VP",
]);

// Markup that starts a text file: HTML (WHATWG sniffing list), XML/SVG.
const MARKUP_START = new RegExp(
  "^(?:<!doctype html|<!--|<\\?xml|<svg|<html|<head|<body|<script|<iframe|<style|<title|<table|<div|<font|<h[1-6]|<a|<b|<br|<p|<img|<form|<math|<link|<meta|<object|<embed)(?=[\\s>/])",
  "i",
);

export function detectType(bytes: Buffer, filename: string): Detection {
  if (bytes.length === 0) return { ok: false, message: "Refused: the file is empty." };

  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { ok: true, contentType: "application/pdf" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ok: true, contentType: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ok: true, contentType: "image/jpeg" };
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return { ok: true, contentType: "image/gif" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { ok: true, contentType: "image/webp" };
  if (ascii(bytes, 4, 8) === "ftyp" && MP4_BRANDS.has(ascii(bytes, 8, 12))) return { ok: true, contentType: "video/mp4" };
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    // EBML header; DocType element (0x42 0x82, length 4) must say "webm" (Matroska says "matroska").
    const head = bytes.subarray(0, 64);
    if (head.indexOf(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])) >= 0) return { ok: true, contentType: "video/webm" };
    return { ok: false, message: NOT_SUPPORTED };
  }

  // Known unsupported containers get a clearer message.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return { ok: false, message: "Refused: zip-based files are not supported. This includes Word and Excel files." };
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { ok: false, message: "Refused: old Word and Excel files are not supported." };
  }

  // Text: valid UTF-8, no NUL bytes.
  if (bytes.includes(0)) return { ok: false, message: NOT_SUPPORTED };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, message: NOT_SUPPORTED };
  }
  const lead = text.replace(/^﻿/, "").trimStart();
  if (MARKUP_START.test(lead)) {
    return { ok: false, message: "Refused: HTML, SVG and XML files are not supported." };
  }
  return { ok: true, contentType: /\.md$/i.test(filename) ? "text/markdown" : "text/plain" };
}
