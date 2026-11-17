import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const REASONING_VERSION = "20261117162313";
const REASONING_MIGRATION = `${REASONING_VERSION}_call_logs_effective_reasoning_effort.sql`;
const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reasoning-migration-"));
const repoMigrations = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/lib/db/migrations"
);
for (const file of [
  "177_provider_connection_synced_models_at.sql",
  "194_proxy_logs_attempt_timing.sql",
  "214_call_logs_client_session_id.sql",
  "218_proxy_subscription_mirror_urls.sql",
  "226_request_cost_ledger_read_indexes.sql",
  REASONING_MIGRATION,
]) {
  fs.copyFileSync(path.join(repoMigrations, file), path.join(migrationsDir, file));
}
for (const version of ["186", "190", "197"]) {
  fs.writeFileSync(path.join(migrationsDir, `${version}_upstream_fixture.sql`), "SELECT 1;");
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
    CREATE TABLE proxy_subscriptions (id TEXT PRIMARY KEY);
    CREATE TABLE request_cost_ledger (
      id INTEGER PRIMARY KEY,
      api_key_id TEXT,
      timestamp TEXT,
      success INTEGER,
      service_tier TEXT,
      amount_usd REAL,
      request_id TEXT
    );
    CREATE INDEX idx_rcl_api_key_timestamp
      ON request_cost_ledger(api_key_id, timestamp);
    INSERT INTO request_cost_ledger (id, api_key_id, request_id, amount_usd)
      VALUES (1, 'existing-key', 'existing-request', 0.25);
  `);
  return db;
}

function createLedger(db: Database.Database) {
  db.exec(`
    CREATE TABLE _omniroute_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function applied(db: Database.Database): Array<{ version: string; name: string }> {
  return db
    .prepare("SELECT version, name FROM _omniroute_migrations ORDER BY length(version), version")
    .all() as Array<{ version: string; name: string }>;
}

const expected = [
  { version: "177", name: "provider_connection_synced_models_at" },
  { version: "186", name: "upstream_fixture" },
  { version: "190", name: "upstream_fixture" },
  { version: "194", name: "proxy_logs_attempt_timing" },
  { version: "197", name: "upstream_fixture" },
  { version: "214", name: "call_logs_client_session_id" },
  { version: "218", name: "proxy_subscription_mirror_urls" },
  { version: "226", name: "request_cost_ledger_read_indexes" },
  { version: REASONING_VERSION, name: "call_logs_effective_reasoning_effort" },
];

function hasColumn(db: Database.Database, table: string, column: string) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row: { name: string }) => row.name === column);
}

function assertReadIndexes(db: Database.Database) {
  const indexes = db.prepare("PRAGMA index_list(request_cost_ledger)").all() as Array<{
    name: string;
  }>;
  const names = indexes.map((index) => index.name);
  assert.ok(names.includes("idx_rcl_api_key_ts_cover"));
  assert.ok(names.includes("idx_rcl_request_id"));
  assert.equal(names.includes("idx_rcl_api_key_timestamp"), false);
  assert.deepEqual(
    db.prepare("SELECT request_id, amount_usd FROM request_cost_ledger WHERE id = 1").get(),
    { request_id: "existing-request", amount_usd: 0.25 }
  );
}

test("fresh databases apply upstream migrations and timestamped reasoning", () => {
  const db = openDb();
  try {
    assert.equal(runMigrations(db, { isNewDb: true }), 9);
    assert.deepEqual(applied(db), expected);
    assertReadIndexes(db);
    assert.equal(hasColumn(db, "provider_connections", "synced_models_at"), true);
    assert.equal(hasColumn(db, "call_logs", "effective_reasoning_effort"), true);
    assert.equal(hasColumn(db, "proxy_subscriptions", "mirror_urls"), true);
    assert.equal(runMigrations(db, { isNewDb: true }), 0);
  } finally {
    db.close();
  }
});

for (const legacyVersion of ["177", "186", "190", "194", "197", "214", "218", "226"]) {
  test(`legacy local ${legacyVersion} reasoning marker frees the upstream slot and preserves rows`, () => {
    const db = openDb();
    try {
      db.exec(`
        ALTER TABLE call_logs ADD COLUMN effective_reasoning_effort TEXT;
        INSERT INTO call_logs (id, effective_reasoning_effort) VALUES ('historic', 'high');
      `);
      createLedger(db);
      db.prepare("INSERT INTO _omniroute_migrations (version, name) VALUES (?, ?)").run(
        legacyVersion,
        "call_logs_effective_reasoning_effort"
      );
      assert.equal(runMigrations(db, { isNewDb: true }), 8);
      assert.deepEqual(applied(db), expected);
      assertReadIndexes(db);
      assert.equal(hasColumn(db, "provider_connections", "synced_models_at"), true);
      assert.equal(hasColumn(db, "proxy_logs", "headers_ms"), true);
      assert.equal(hasColumn(db, "proxy_logs", "first_chunk_ms"), true);
      assert.equal(hasColumn(db, "call_logs", "client_session_id"), true);
      assert.equal(hasColumn(db, "proxy_subscriptions", "mirror_urls"), true);
      assert.deepEqual(
        db.prepare("SELECT effective_reasoning_effort FROM call_logs WHERE id = ?").get("historic"),
        { effective_reasoning_effort: "high" }
      );
      assert.equal(runMigrations(db, { isNewDb: true }), 0);
    } finally {
      db.close();
    }
  });
}

test("legacy reasoning and upstream 177 markers preserve the synced models column", () => {
  const db = openDb();
  try {
    db.exec(`
      ALTER TABLE call_logs ADD COLUMN effective_reasoning_effort TEXT DEFAULT NULL;
      ALTER TABLE provider_connections ADD COLUMN synced_models_at TEXT;
    `);
    createLedger(db);
    db.exec(`
      INSERT INTO _omniroute_migrations (version, name) VALUES
        ('177', 'provider_connection_synced_models_at'),
        ('194', 'call_logs_effective_reasoning_effort');
    `);
    assert.equal(runMigrations(db, { isNewDb: true }), 7);
    assert.deepEqual(applied(db), expected);
    assertReadIndexes(db);
    assert.equal(runMigrations(db, { isNewDb: true }), 0);
  } finally {
    db.close();
  }
});

test("upstream 218 is never rehomed by the fork compatibility mapping", () => {
  const db = openDb();
  try {
    createLedger(db);
    db.exec(`
      INSERT INTO _omniroute_migrations (version, name)
        VALUES ('218', 'proxy_subscription_mirror_urls');
      ALTER TABLE proxy_subscriptions ADD COLUMN mirror_urls TEXT;
    `);
    assert.equal(runMigrations(db, { isNewDb: true }), 8);
    assert.deepEqual(applied(db), expected);
    assertReadIndexes(db);
    assert.equal(hasColumn(db, "call_logs", "effective_reasoning_effort"), true);
    assert.equal(runMigrations(db, { isNewDb: true }), 0);
  } finally {
    db.close();
  }
});

test("legacy reasoning rows cannot overwrite an unrelated canonical target", () => {
  const db = openDb();
  try {
    db.exec("ALTER TABLE call_logs ADD COLUMN effective_reasoning_effort TEXT;");
    createLedger(db);
    db.prepare("INSERT INTO _omniroute_migrations (version, name) VALUES (?, ?)").run(
      "218",
      "call_logs_effective_reasoning_effort"
    );
    db.prepare("INSERT INTO _omniroute_migrations (version, name) VALUES (?, ?)").run(
      REASONING_VERSION,
      "unrelated_migration"
    );
    assert.throws(
      () => runMigrations(db, { isNewDb: true }),
      new RegExp(`target version ${REASONING_VERSION} is occupied`)
    );
    assert.deepEqual(applied(db), [
      { version: "218", name: "call_logs_effective_reasoning_effort" },
      { version: REASONING_VERSION, name: "unrelated_migration" },
    ]);
  } finally {
    db.close();
  }
});

test("upstream 226 keeps its identity while reasoning migrates separately", () => {
  const db = openDb();
  try {
    createLedger(db);
    db.exec(`
      INSERT INTO _omniroute_migrations (version, name)
        VALUES ('226', 'request_cost_ledger_read_indexes');
    `);
    db.exec(
      fs.readFileSync(path.join(repoMigrations, "226_request_cost_ledger_read_indexes.sql"), "utf8")
    );
    assert.equal(runMigrations(db, { isNewDb: true }), 8);
    assert.deepEqual(applied(db), expected);
    assertReadIndexes(db);
    assert.equal(hasColumn(db, "call_logs", "effective_reasoning_effort"), true);
    assert.equal(runMigrations(db, { isNewDb: true }), 0);
  } finally {
    db.close();
  }
});
