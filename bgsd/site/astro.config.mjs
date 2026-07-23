import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  output: "static",
  integrations: [
    starlight({
      title: "BGSD",
      description:
        "Harness-agnostic verified GSD conductor — parallel worktrees, real verification, main stays protected.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/filippo-fonseca/better-gsd",
        },
      ],
      customCss: ["./src/styles/starlight.css"],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Overview", slug: "overview" },
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
