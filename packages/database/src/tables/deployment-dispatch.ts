import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { Deployments } from "./deployment";

// Only admissions made by the durable handoff have a record. Historical
// deployments must never be backfilled into the queue.
export const DeploymentDispatches = pgTable(
  "DeploymentDispatches",
  {
    deploymentId: bigint({ mode: "number" })
      .primaryKey()
      .references(() => Deployments.id),
    userId: text().notNull(),
    submissionId: uuid().notNull(),
    requestHash: text().notNull(),
    state: text({ enum: ["pending", "dispatched", "rejected"] })
      .notNull()
      .default("pending"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lease: uuid(),
    leaseUntil: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("DeploymentDispatches_owner_submission").on(
      table.userId,
      table.submissionId,
    ),
    check(
      "DeploymentDispatches_state",
      sql`${table.state} IN ('pending', 'dispatched', 'rejected')`,
    ),
    index("DeploymentDispatches_pending_due")
      .on(table.nextAttemptAt)
      .where(sql`${table.state} = 'pending'`),
  ],
);
