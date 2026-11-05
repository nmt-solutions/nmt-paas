/** An app is usable only by its owner while both it and its project are active. */
export const activeAppEligibility = (userId: string) => ({
  createdBy: userId,
  resourceStatus: "active" as const,
  project: { userId, resourceStatus: "active" as const },
});
