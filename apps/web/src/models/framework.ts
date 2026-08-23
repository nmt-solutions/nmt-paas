export type Framework =
  | "docker"
  | "vite"
  | "nextjs"
  | "react"
  | "node"
  | "unknown";

export interface FrameworkConfigPreset {
  framework: Framework;
  rootDirectory: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  outputDirectory: string;
  port: number;
  iconUrl: string;
}
