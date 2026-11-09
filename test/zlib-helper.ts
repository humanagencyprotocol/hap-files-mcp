import { deflateSync } from "node:zlib";
export const zlibSync = (b: Buffer) => deflateSync(b);
