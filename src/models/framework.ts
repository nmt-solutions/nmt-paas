export type Framework =
  | "docker"
  | "vite"
  | "nextjs"
  | "react"
  | "node"
  | "unknown";

export type FrameworkDefaultConfig = {
  framework: Framework;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  outputDirectory: string;
  iconUrl: string;
};
