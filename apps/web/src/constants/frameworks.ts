import type { Framework, FrameworkConfigPreset } from "@/models/framework";

export const FRAMEWORK_PRESETS = (
  provider: "github",
): Record<Framework, FrameworkConfigPreset> => ({
  docker: {
    framework: "docker",
    rootDirectory: "./",
    installCommand: "",
    buildCommand: "docker build -t app .",
    startCommand: "docker run -p 3000:3000 app",
    outputDirectory: "",
    iconUrl: "/assets/frameworks/docker.svg",
  },

  vite: {
    framework: "vite",
    rootDirectory: "./",
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npm run preview",
    outputDirectory: "dist",
    iconUrl: "/assets/frameworks/vite.svg",
  },

  nextjs: {
    framework: "nextjs",
    rootDirectory: "apps/web",
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npm start",
    outputDirectory: ".next",
    iconUrl: "/assets/frameworks/nextjs.svg",
  },

  react: {
    framework: "react",
    rootDirectory: "/",
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npx serve -s build",
    outputDirectory: "build",
    iconUrl: "/assets/frameworks/react.svg",
  },

  node: {
    framework: "node",
    rootDirectory: "/",
    installCommand: "npm install",
    buildCommand: "npm install",
    startCommand: "npm start",
    outputDirectory: "",
    iconUrl: "/assets/frameworks/nodejs.svg",
  },

  unknown: {
    framework: "unknown",
    rootDirectory: "/",
    installCommand: "npm install",
    buildCommand: "npm install",
    startCommand: "npm start",
    outputDirectory: "",
    iconUrl: `/assets/frameworks/${provider}.svg`,
  },
});
