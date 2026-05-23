import type { Framework, FrameworkDefaultConfig } from "@/models/framework";

export const FRAMEWORK_PRESETS = (
  provider: "github",
): Record<Framework, FrameworkDefaultConfig> => ({
  docker: {
    framework: "docker",
    installCommand: "",
    buildCommand: "docker build -t app .",
    startCommand: "docker run -p 3000:3000 app",
    outputDirectory: "",
    iconUrl: "/assets/frameworks/docker.svg",
  },

  vite: {
    framework: "vite",
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npm run preview",
    outputDirectory: "dist",
    iconUrl: "/assets/frameworks/vite.svg",
  },

  nextjs: {
    framework: "nextjs",
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npm start",
    outputDirectory: ".next",
    iconUrl: "/assets/frameworks/nextjs.svg",
  },

  react: {
    framework: "react",
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npx serve -s build",
    outputDirectory: "build",
    iconUrl: "/assets/frameworks/react.svg",
  },

  node: {
    framework: "node",
    installCommand: "npm install",
    buildCommand: "npm install",
    startCommand: "npm start",
    outputDirectory: "",
    iconUrl: "/assets/frameworks/nodejs.svg",
  },

  unknown: {
    framework: "unknown",
    installCommand: "npm install",
    buildCommand: "npm install",
    startCommand: "npm start",
    outputDirectory: "",
    iconUrl: `/assets/frameworks/${provider}.svg`,
  },
});
