export type Framework =
  | "docker"
  | "vite"
  | "nextjs"
  | "react"
  | "node"
  | "unknown";

export type FrameworkConfigPreset = {
  framework: Framework;
  rootDirectory: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  outputDirectory: string;
  iconUrl: string;
};
