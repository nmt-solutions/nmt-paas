import { execa } from "execa";

export async function cloneRepo(repo: string, dir: string) {
  await execa("git", ["clone", repo, dir], {
    stdio: "inherit",
  });
}
