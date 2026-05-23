import { timestamp as pgTimeStamp } from "drizzle-orm/pg-core";
import { ResourceStatus as ResourceStatusEnum } from "./enums";

export const ResourceStatus = (name = "resourceStatus") =>
  ResourceStatusEnum(name).notNull().default("active");

export const timestamp = (name: string) =>
  pgTimeStamp(name, { withTimezone: true });

export const timestampDefault = (
  name: string,
  params?: { frequent?: boolean },
) => {
  const baseTimestamp = timestamp(name).defaultNow();

  const { frequent } = params ?? {};

  if (frequent) {
    return baseTimestamp.$onUpdateFn(() => new Date());
  }

  return baseTimestamp.notNull();
};
