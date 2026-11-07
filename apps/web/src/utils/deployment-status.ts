/** Display the historical execution result without implying current health. */
export const deploymentStatusLabel = (status: string) =>
  status === "success" ? "Container started" : status;
