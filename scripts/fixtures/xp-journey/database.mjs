import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import pg from "pg";

export async function setupDatabase() {
  const options = process.env.POSTGRES_URL
    ? { connectionString: process.env.POSTGRES_URL }
    : {
        host: process.env.PGHOST ?? "127.0.0.1",
        port: Number(process.env.PGPORT ?? 5433),
        user: process.env.PGUSER ?? "test_user",
        password: process.env.PGPASSWORD ?? "test_password",
        database: process.env.PGDATABASE ?? "test_db",
      };
  const schema = `xp_journey_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client(options);
  await admin.connect();
  const pool = new pg.Pool({ ...options, options: `-c search_path=${schema}` });
  const close = async () => {
    try {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await pool.query("CREATE TABLE users (id TEXT PRIMARY KEY)");
    await pool.query("INSERT INTO users (id) VALUES ('shopper'), ('alice'), ('bob')");
    const migrations = (await readdir("migrations"))
      .filter((file) => file.endsWith(".up.sql"))
      .sort();
    assert.ok(migrations.length, "xp setup generated migrations");
    for (const file of migrations)
      await pool.query(await readFile(join("migrations", file), "utf8"));
    return { pool, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function assignedSlugs(pool, user) {
  const records = await pool.query(
    "SELECT c.slug FROM user_cohorts m JOIN cohorts c ON c.id=m.cohort_id JOIN experiments e ON e.id=m.experiment_id WHERE m.user_id=$1 AND e.slug=$2",
    [user, "delivery-copy"],
  );
  return records.rows.map((row) => row.slug);
}
