import process from "node:process";
// Fresh process exercising the same authenticated request boundary after restart.
import { appRouter } from "../../src/trpc/routers/_app.ts";
import { database } from "@repo/database";
try {
  const caller = appRouter.createCaller({
    userInfo: { user: { id: process.argv[3] } },
  });
  const input = { appId: Number(process.argv[2]) };
  const result =
    process.argv[4] === "retry"
      ? await caller.app.delete(input)
      : await caller.app.retirementStatus(input);
  console.log(JSON.stringify(result));
} finally {
  await database.$client.end();
}

process.exit(0);
