import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const BASE_DIR = path.join(process.cwd(), "packages", "docker");

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: npm run docker -- <command>");
  process.exit(1);
}

const [command, ...dockerArgs] = args;

try {
  execSync("docker --version", {
    stdio: "ignore",
  });
} catch {
  console.error("Docker is not installed or Docker Desktop is not running.");
  process.exit(1);
}

console.log(`Running docker compose ${command} across all docker projects...`);

if (!fs.existsSync(BASE_DIR)) {
  console.error(`Directory not found: ${BASE_DIR}`);
  process.exit(1);
}

const directories = fs.readdirSync(BASE_DIR);

for (const dirName of directories) {
  const dirPath = path.join(BASE_DIR, dirName);

  if (!fs.statSync(dirPath).isDirectory()) {
    continue;
  }

  const composeFile = path.join(dirPath, "docker-compose.yml");

  if (!fs.existsSync(composeFile)) {
    continue;
  }

  console.log("\n=========================================");
  console.log(`Project: ${dirName}`);
  console.log("=========================================");

  try {
    execSync(`docker compose ${command} ${dockerArgs.join(" ")}`, {
      cwd: dirPath,
      stdio: "inherit",
    });
  } catch (error) {
    console.error(`Failed for project: ${dirName}`);
    process.exit(1);
  }
}
