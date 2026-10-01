import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-migration-197-"));
const repoMigrations = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/lib/db/migrations"
);
for (const file of [
  "177_provider_connection_synced_models_at.sql",
  "194_proxy_logs_attempt_timing.sql",
  "197_call_logs_effective_reasoning_effort.sql",
]) {
  fs.copyFileSync(path.join(repoMigrations, file), path.join(migrationsDir, file));
}
const originalMigrationsDir = process.env.OMNIROUTE_MIGRATIONS_DIR;
process.env.OMNIROUTE_MIGRATIONS_DIR = migrationsDir;

const { runMigrations } = await import("../../src/lib/db/migrationRunner.ts");

test.after(() => {
  fs.rmSync(migrationsDir, { recursive: true, force: true });
  if (originalMigrationsDir === undefined) delete process.env.OMNIROUTE_MIGRATIONS_DIR;
  else process.env.OMNIROUTE_MIGRATIONS_DIR = originalMigrationsDir;
});

function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE provider_connections (id TEXT PRIMARY KEY);
    CREATE TABLE call_logs (id TEXT PRIMARY KEY);
    CREATE TABLE proxy_logs (id TEXT PRIMARY KEY);
  `);
  return db;
}

function applied(db: Database.Database): Array<{ version: string; name: string }> {
  return db
    .prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version")
    .all() as Array<{ version: string; name: string }>;
}

const expected = [
  { version: "177", name: "provider_connection_synced_models_at" },
  { version: "194", name: "proxy_logs_attempt_timing" },
  { version: "197", name: "call_logs_effective_reasoning_effort" },
];

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((info: { name: string }) => info.name === column);
}

test("fresh databases apply upstream 177/194 and the local 197 migration", () => {
  const db = openDb();
  try {
    assert.equal(runMigrations(db, { isNewDb: true }), 3);
    assert.deepEqual(applied(db), expected);
    assert.ok(
      db
        .prepare("PRAGMA table_info(provider_connections)")
        .all()
        .some((column: { name: string }) => column.name === "synced_models_at")
    );
    assert.ok(
      db
        .prepare("PRAGMA table_info(call_logs)")
        .all()
        .some((column: { name: string }) => column.name === "effective_reasoning_effort")
    );
    assert.equal(runMigrations(db, { isNewDb: true }), 0);
  } finally {
    db.close();
  }
});

test("a database with the local 177 migration rehomes its marker and applies upstream 177/194", () => {
  const db = openDb();
  try {
    db.exec(`
      ALTER TABLE call_logs ADD COLUMN effective_reasoning_effort TEXT DEFAULT NULL;
      CREATE TABLE _omniroute_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO _omniroute_migrations (version, name)
        VALUES ('177', 'call_logs_effective_reasoning_effort');
    `);
    db.prepare("INSERT INTO call_logs (id, effective_reasoning_effort) VALUES (?, ?)").run(
      "existing",
      "high"
    );
    assert.equal(runMigrations(db, { isNewDb: true }), 2);
    assert.deepEqual(applied(db), expected);
    assert.equal(
      (
        db
          .prepare("SELECT effective_reasoning_effort FROM call_logs WHERE id = ?")
          .get("existing") as { effective_reasoning_effort: string }
      ).effective_reasoning_effort,
      "high"
    );
    assert.equal(runMigrations(db, { isNewDb: true }), 0);
  } finally {
    db.close();
  }
});

test("a database with the local 194 migration rehomes it to 197 and applies upstream 194", () => {
  const db = openDb();
  try {
    db.exec(`
      ALTER TABLE call_logs ADD COLUMN effective_reasoning_effort TEXT DEFAULT NULL;
      CREATE TABLE _omniroute_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO _omniroute_migrations (version, name) VALUES
        ('177', 'provider_connection_synced_models_at'),
        ('194', 'call_logs_effective_reasoning_effort');
      ALTER TABLE provider_connections ADD COLUMN synced_models_at TEXT;
    `);
    db.prepare("INSERT INTO call_logs (id, effective_reasoning_effort) VALUES (?, ?)").run(
      "existing",
      "max"
    );
    assert.equal(runMigrations(db, { isNewDb: true }), 1);
    assert.deepEqual(applied(db), expected);
    assert.equal(hasColumn(db, "proxy_logs", "headers_ms"), true);
    assert.equal(hasColumn(db, "proxy_logs", "first_chunk_ms"), true);
    assert.equal(
      (
        db
          .prepare("SELECT effective_reasoning_effort FROM call_logs WHERE id = ?")
          .get("existing") as { effective_reasoning_effort: string }
      ).effective_reasoning_effort,
      "max"
    );
    assert.equal(runMigrations(db, { isNewDb: true }), 0);
  } finally {
    db.close();
  }
});
