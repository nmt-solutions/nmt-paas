import { Framework, FrameworkConfigPreset } from "@/models/framework";

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
    port: 3000,
    iconUrl: "/assets/frameworks/docker.svg",
  },

  vite: {
    framework: "vite",
    rootDirectory: "./",
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npm run preview -- --host 0.0.0.0",
    outputDirectory: "dist",
    port: 4173,
    iconUrl: "/assets/frameworks/vite.svg",
  },

  nextjs: {
    framework: "nextjs",
    rootDirectory: "apps/web",
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npm start -- --hostname 0.0.0.0 --port 3000",
    outputDirectory: ".next",
    port: 3000,
    iconUrl: "/assets/frameworks/nextjs.svg",
  },

  react: {
    framework: "react",
    rootDirectory: "/",
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npx serve -s build -l tcp://0.0.0.0:3000",
    outputDirectory: "build",
    port: 3000,
    iconUrl: "/assets/frameworks/react.svg",
  },

  node: {
    framework: "node",
    rootDirectory: "/",
    installCommand: "npm install",
    buildCommand: "npm install",
    startCommand: "npm start",
    outputDirectory: "",
    port: 3000,
    iconUrl: "/assets/frameworks/nodejs.svg",
  },

  unknown: {
    framework: "unknown",
    rootDirectory: "/",
    installCommand: "npm install",
    buildCommand: "npm install",
    startCommand: "npm start",
    outputDirectory: "",
    port: 3000,
    iconUrl: `/assets/frameworks/${provider}.svg`,
  },
});
