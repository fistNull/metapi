import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveSqliteDbPath(): string {
  const raw = (config.dbUrl || '').trim();
  if (!raw) return resolve(`${config.dataDir}/hub.db`);
  if (raw === ':memory:') return raw;
  if (raw.startsWith('file://')) {
    const parsed = new URL(raw);
    return decodeURIComponent(parsed.pathname);
  }
  if (raw.startsWith('sqlite://')) {
    return resolve(raw.slice('sqlite://'.length).trim());
  }
  return resolve(raw);
}

function resolveMigrationsFolder(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');
}

export function runSqliteMigrations(): void {
  const dbPath = resolveSqliteDbPath();
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  sqlite.close();
  console.log('Migration complete.');
}

runSqliteMigrations();
