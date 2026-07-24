import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import bgsdTheme from "./src/styles/shiki-bgsd.json";

export default defineConfig({
  site: "https://better-gsd.vercel.app",
  output: "static",
  markdown: {
    shikiConfig: {
      themes: {
        dark: bgsdTheme,
      },
      defaultColor: "dark",
    },
  },
  integrations: [
    mermaid({
      theme: "dark",
      autoTheme: true,
      mermaidConfig: {
        themeVariables: {
          darkMode: true,
          background: "#090d11",
          primaryColor: "#1a2330",
          primaryTextColor: "#eae6ff",
          primaryBorderColor: "#2a3446",
          secondaryColor: "#141a22",
          tertiaryColor: "#0f141b",
          lineColor: "#9aa6bc",
          textColor: "#eae6ff",
          mainBkg: "#1a2330",
          nodeBorder: "#a3e635",
          clusterBkg: "#0f141b",
          titleColor: "#a3e635",
          edgeLabelBackground: "#090d11",
        },
      },
    }),
    starlight({
      title: "bgsd",
      description:
        "Harness-agnostic verified GSD conductor — parallel worktrees, real verification, main stays protected.",
      logo: {
        src: "./src/assets/logo.svg",
        alt: "bgsd",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/filippo-fonseca/better-gsd",
        },
      ],
      customCss: ["./src/styles/starlight.css"],
      expressiveCode: {
        themes: [bgsdTheme],
        defaultProps: {
          wrap: true,
        },
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Overview", slug: "" },
            { label: "Install", slug: "install" },
            { label: "Quickstart", slug: "quickstart" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Mental model", slug: "mental-model" },
            { label: "Harnesses", slug: "harnesses" },
            { label: "Models & routing", slug: "models" },
            { label: "Branch & safety", slug: "branch-safety" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Conductor session", slug: "conductor-session" },
            { label: "Doctor", slug: "doctor" },
            { label: "Configuration", slug: "configuration" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Commands", slug: "commands" },
            { label: "Troubleshooting", slug: "troubleshooting" },
          ],
        },
      ],
    }),
  ],
});
