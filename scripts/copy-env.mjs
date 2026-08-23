import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const copyEnvFiles = () => {
  const rootDir = process.cwd();
  const sourceEnv = path.join(rootDir, ".env");

  if (!fs.existsSync(sourceEnv)) {
    console.error(`Root .env not found: ${sourceEnv}`);
    process.exit(1);
  }

  const workspaces = ["apps", "packages"];

  for (const workspaceDir of workspaces) {
    const workspacePath = path.join(rootDir, workspaceDir);

    if (!fs.existsSync(workspacePath)) {
      continue;
    }

    const entries = fs.readdirSync(workspacePath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const destination = path.join(workspacePath, entry.name, ".env");

      fs.copyFileSync(sourceEnv, destination);

      console.log(`Copied .env → ${workspaceDir}/${entry.name}/.env`);
    }
  }

  console.log("Copy Env File Done.");
};

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (currentFile === executedFile) {
  copyEnvFiles();
}
