import process from "node:process";
import { projectRouter } from "../../../../apps/web/src/trpc/routers/project.trpc.ts";

const caller = projectRouter.createCaller({
  userInfo: { user: { id: "database-selection-owner" } },
});

try {
  const before = await caller.list();
  const project = before[0];
  if (project) await caller.deleteProject({ projectId: project.id });
  const after = await caller.list();
  process.stdout.write(JSON.stringify({ before, after }));
  process.exit(0);
} catch (error) {
  process.stderr.write(String(error));
  process.exit(1);
}
