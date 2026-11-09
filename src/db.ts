import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Db {
  run(sql: string, params?: any[]): void;
  get<T>(sql: string, params?: any[]): T | undefined;
  all<T>(sql: string, params?: any[]): T[];
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ticket_id TEXT,
  warnings TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);
-- A saved document never changes: the index refuses UPDATE and DELETE too.
CREATE TRIGGER IF NOT EXISTS documents_no_update BEFORE UPDATE ON documents
BEGIN SELECT RAISE(ABORT, 'documents are immutable'); END;
CREATE TRIGGER IF NOT EXISTS documents_no_delete BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'documents are immutable'); END;
`;

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HAP_DATA_DIR || join(homedir(), ".hap");
}

export async function createDb(env: NodeJS.ProcessEnv = process.env): Promise<Db> {
  const dir = dataDir(env);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "documents.db");
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  console.error(`[documents-mcp] using SQLite at ${dbPath}`);
  return {
    run: (sql, params = []) => { db.prepare(sql).run(...params); },
    get: <T>(sql: string, params: any[] = []) => db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, params: any[] = []) => db.prepare(sql).all(...params) as T[],
    close: () => db.close(),
  };
}
