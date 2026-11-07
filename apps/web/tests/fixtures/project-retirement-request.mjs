import process from "node:process";
import { appRouter } from "../../src/trpc/routers/_app.ts";
import { database } from "@repo/database";

try {
  const caller = appRouter.createCaller({
    userInfo: { user: { id: process.argv[3] } },
  });
  const input = { projectId: Number(process.argv[2]) };
  const result =
    process.argv[4] === "retry"
      ? await caller.project.deleteProject(input)
      : await caller.project.retirementStatus(input);
  console.log(JSON.stringify(result));
} finally {
  await database.$client.end();
}
process.exit(0);
