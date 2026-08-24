import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: path.join(process.cwd(), ".env") });

const force = process.argv.includes("--force");
const allowProduction = process.env.ALLOW_PRODUCTION_RESET === "true";
const environment = (process.env.DB_ENV ?? "development").replaceAll('"', "");
const databaseUrl =
  environment === "production"
    ? process.env.PROD_DATABASE_URL
    : process.env.DEV_DATABASE_URL;

if (!force) {
  throw new Error("Refusing reset without --force.");
}

if (environment === "production" && !allowProduction) {
  throw new Error(
    "Refusing to reset production. Set ALLOW_PRODUCTION_RESET=true only when this is intentional.",
  );
}

if (!databaseUrl) {
  throw new Error("Database URL is not configured for the selected environment.");
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

const listDockerIds = (args) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Docker command failed: docker ${args.join(" ")}`);
  }
  return [...new Set(result.stdout.trim().split("\n").filter(Boolean))];
};

async function resetDatabase() {
  console.log(`Resetting ${environment} database schema…`);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
  run("npm", ["run", "db-mig", "--workspace=@repo/database"]);
}

function resetDocker() {
  console.log("Removing all Docker resources on this host…");
  const containers = listDockerIds(["ps", "-aq"]);
  if (containers.length) run("docker", ["rm", "-f", ...containers]);

  const images = listDockerIds(["images", "-aq"]);
  if (images.length) run("docker", ["image", "rm", "-f", ...images]);

  const volumes = listDockerIds(["volume", "ls", "-q"]);
  if (volumes.length) run("docker", ["volume", "rm", "-f", ...volumes]);

  run("docker", ["network", "prune", "-f"]);
  run("docker", ["builder", "prune", "-a", "-f"]);
}

await resetDatabase();
resetDocker();
console.log("Reset complete. The database is migrated and Docker is empty.");
