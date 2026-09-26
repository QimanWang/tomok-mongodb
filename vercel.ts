import { withEve } from "eve/vercel";

const config = await withEve({
  services: {
    web: { framework: "nextjs", root: "apps/web" },
  },
  routes: [{ src: "^(.*)$", destination: { type: "service", service: "web" } }],
});

const agentService = config.services.eve;
if (agentService?.framework !== "eve" || typeof agentService.buildCommand !== "string") {
  throw new Error("The generated eve service must expose its build command for source packaging.");
}
// Keep the generated service, workflow, and schedule wiring; add private runtime data.
export default {
  ...config,
  services: {
    ...config.services,
    eve: { ...agentService, buildCommand: `${agentService.buildCommand} && node scripts/package-eve-sources.mjs` },
  },
};
