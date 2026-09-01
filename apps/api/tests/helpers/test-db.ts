/**
 * Throwaway SQLite database for tests: a fresh temp file with the real
 * migration SQL applied (dev.db is gitignored, so tests must never depend on
 * it). Deterministic — one db per test file, removed on cleanup.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const MIGRATIONS_DIR = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "prisma", "migrations");

export interface TestDatabase {
  url: string;
  dir: string;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const dir = mkdtempSync(path.join(tmpdir(), "agentic-trading-test-db-"));
  const url = `file:${path.join(dir, "test.db")}`;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const migration of migrations) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, migration, "migration.sql"), "utf8");
      for (const statement of sql.split(";")) {
        if (statement.trim()) await prisma.$executeRawUnsafe(statement);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  return { url, dir };
}

export function destroyTestDatabase(db: TestDatabase): void {
  rmSync(db.dir, { recursive: true, force: true });
}
