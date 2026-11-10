import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API_BASE = "https://api.cloudflare.com/client/v4";
const WRANGLER_LOCAL_DATABASE_ID = "00000000-0000-0000-0000-000000000001";
const REQUIRED_MIGRATIONS = [
  "0001_events.sql",
  "0002_admin.sql",
  "0003_containment_sources.sql",
  "0004_more_lure_routes.sql",
  "0005_rabbit_hole_events.sql",
];
const MIGRATIONS_TABLE = "__moqesh_schema_migrations";

export async function applyD1Migrations({
  accountId,
  databaseId,
  migrationsDirectory,
  installationId,
  settings,
  token = process.env.CLOUDFLARE_API_TOKEN,
  fetcher = fetch,
}) {
  validateAccountId(accountId);
  validateDatabaseId(databaseId);
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  if (!installationId || installationId.length > 128) {
    throw new Error("A valid installation ID is required");
  }
  validateSettings(settings);

  const sqlFiles = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const migrationNames = sqlFiles.filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(name));
  if (migrationNames.length !== sqlFiles.length) {
    throw new Error("Every D1 SQL file must use the ordered NNNN_name.sql migration format");
  }
  for (const requiredMigration of REQUIRED_MIGRATIONS) {
    if (!migrationNames.includes(requiredMigration)) {
      throw new Error(`Required D1 migration is missing: ${requiredMigration}`);
    }
  }
  const query = (sql, params = []) => d1Query({
    accountId,
    databaseId,
    sql,
    params,
    token,
    fetcher,
  });

  await query(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    )`,
  );
  const appliedRows = await query(
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`,
  );
  const applied = new Set(appliedRows.map((row) => row.name));

  for (const name of migrationNames) {
    if (applied.has(name)) continue;
    const sql = await readFile(new URL(name, ensureDirectoryUrl(migrationsDirectory)), "utf8");
    const result = await d1Batch({
      accountId,
      databaseId,
      queries: [
        { sql },
        {
          sql: `INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`,
          params: [name, String(Date.now())],
        },
      ],
      token,
      fetcher,
    });
    if (!result) throw new Error(`Cloudflare did not confirm migration ${name}`);
    console.log(`Applied D1 migration ${name}`);
  }

  const verifiedRows = await query(
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`,
  );
  const verified = new Set(verifiedRows.map((row) => row.name));
  for (const name of REQUIRED_MIGRATIONS) {
    if (!verified.has(name)) {
      throw new Error(`D1 migration verification failed for ${name}`);
    }
  }

  await query(
    `INSERT INTO runtime_settings (
      installation_id, lures_enabled, maze_duration_minutes, block_duration_hours,
      response_budget, alert_grouping_minutes, retention_days
    ) VALUES (?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(installation_id) DO NOTHING`,
    [
      installationId,
      settings.mazeDurationMinutes,
      settings.blockDurationHours,
      settings.responseBudget,
      settings.alertGroupingMinutes,
      settings.retentionDays,
    ].map(String),
  );
  const settingsRows = await query(
    "SELECT installation_id FROM runtime_settings WHERE installation_id = ?",
    [installationId],
  );
  if (!settingsRows.some((row) => row.installation_id === installationId)) {
    throw new Error("D1 runtime settings verification failed");
  }

  console.log("Verified D1 migrations 0001 through 0005 and initialized runtime settings");
}

async function d1Query({ accountId, databaseId, sql, params, token, fetcher }) {
  const response = await fetcher(
    `${API_BASE}/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const payload = await readApiResponse(response);
  const firstResult = Array.isArray(payload.result) ? payload.result[0] : null;
  return firstResult?.results ?? [];
}

async function d1Batch({ accountId, databaseId, queries, token, fetcher }) {
  const response = await fetcher(
    `${API_BASE}/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batch: queries }),
    },
  );
  const payload = await readApiResponse(response);
  // D1 returns one result per SQL statement, including multi-statement queries.
  return Array.isArray(payload.result)
    && payload.result.length >= queries.length
    && payload.result.every((item) => item?.success === true);
}

async function readApiResponse(response) {
  if (!response.ok) {
    throw new Error(`Cloudflare API request failed with HTTP ${response.status}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Cloudflare API returned an invalid response");
  }
  if (payload.success !== true) {
    throw new Error("Cloudflare API rejected the D1 operation");
  }
  return payload;
}

function validateAccountId(accountId) {
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("A valid Cloudflare account ID is required");
  }
}

function validateDatabaseId(databaseId) {
  if (databaseId === WRANGLER_LOCAL_DATABASE_ID) {
    throw new Error("Refusing Wrangler local placeholder D1 database ID");
  }
  if (
    typeof databaseId !== "string"
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(databaseId)
  ) {
    throw new Error("A real Terraform D1 database ID is required");
  }
}

function validateSettings(settings) {
  const constraints = [
    ["mazeDurationMinutes", 1, 120],
    ["blockDurationHours", 1, 168],
    ["responseBudget", 1, 10_000],
    ["alertGroupingMinutes", 1, 60],
    ["retentionDays", 1, 30],
  ];
  for (const [name, minimum, maximum] of constraints) {
    if (
      !Number.isInteger(settings?.[name])
      || settings[name] < minimum
      || settings[name] > maximum
    ) {
      throw new Error(`Invalid D1 runtime setting: ${name}`);
    }
  }
}

function ensureDirectoryUrl(directory) {
  const url = directory instanceof URL
    ? new URL(directory)
    : pathToFileURL(resolve(directory));
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function readEnvironment() {
  const integer = (name) => {
    const value = Number(process.env[name]);
    if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
    return value;
  };
  return {
    accountId: process.env.MOQESH_ACCOUNT_ID,
    databaseId: process.env.MOQESH_D1_DATABASE_ID,
    migrationsDirectory: process.env.MOQESH_MIGRATIONS_DIRECTORY,
    installationId: process.env.MOQESH_INSTALLATION_ID,
    settings: {
      mazeDurationMinutes: integer("MOQESH_MAZE_DURATION_MINUTES"),
      blockDurationHours: integer("MOQESH_BLOCK_DURATION_HOURS"),
      responseBudget: integer("MOQESH_RESPONSE_BUDGET"),
      alertGroupingMinutes: integer("MOQESH_ALERT_GROUPING_MINUTES"),
      retentionDays: integer("MOQESH_RETENTION_DAYS"),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  applyD1Migrations(readEnvironment()).catch((error) => {
    console.error(error instanceof Error ? error.message : "D1 migration failed");
    process.exitCode = 1;
  });
}
