import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};

  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((values, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return values;

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) return values;

      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      values[match[1]] = value;
      return values;
    }, {});
}

const fileEnv = {
  ...parseEnvFile(join(rootDir, ".env")),
  ...parseEnvFile(join(rootDir, ".env.local")),
};
const databaseUrl = process.env.DBOPENSTUDIO_DATABASE_URL || fileEnv.DBOPENSTUDIO_DATABASE_URL;

if (!databaseUrl) {
  console.error("DBOPENSTUDIO_DATABASE_URL is not configured. Set it in .env.local or export it before running db:setup.");
  process.exit(1);
}

const schemaPath = join(rootDir, "supabase", "schema.sql");
const result = spawnSync("psql", [databaseUrl, "-f", schemaPath], {
  cwd: rootDir,
  env: {
    ...fileEnv,
    ...process.env,
    DBOPENSTUDIO_DATABASE_URL: databaseUrl,
  },
  stdio: "inherit",
});

if (result.error) {
  console.error(`Could not run psql: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
