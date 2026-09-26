import { defineAgent } from "eve";

export default defineAgent({
  // Only authored tools can enforce the immutable replay scope. This also removes
  // shell, web, sandbox file access, and root-copy delegation as alternate paths.
  defaultTools: false,
  model: "anthropic/claude-sonnet-5",
});
