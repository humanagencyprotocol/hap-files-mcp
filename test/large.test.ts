import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { startWorld, sha256, PNG_HEAD } from "./helpers.js";

const MAX = 25 * 1024 * 1024;

describe("25 MiB over real stdio", () => {
  it("save + get_document returns the exact bytes", async () => {
    const w = await startWorld();
    try {
      const buf = Buffer.concat([PNG_HEAD, randomBytes(MAX - PNG_HEAD.length)]);
      expect(buf.length).toBe(MAX);
      w.put("huge.png", buf);
      const s = await w.save("huge.png");
      expect(s.isError, JSON.stringify(s.data)).toBe(false);
      expect(s.data.bytes).toBe(MAX); expect(s.data.sha256).toBe(sha256(buf));
      const g = await w.call("get_document", { kind: "file", id: s.data.id });
      expect(g.isError).toBe(false);
      const back = Buffer.from(g.data.contentBase64, "base64");
      expect(back.length).toBe(MAX);
      expect(back.equals(buf)).toBe(true);
      expect(g.data.sha256).toBe(sha256(buf)); expect(g.data.contentType).toBe("image/png");
    } finally { await w.close(); }
  });
});
