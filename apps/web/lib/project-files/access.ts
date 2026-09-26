import { getServerViewer } from "@/lib/session";
import { getSetupStatus } from "@/lib/setup";
import { SourceError } from "./catalog";

export async function requireProjectAccess() {
  const setup = await getSetupStatus();
  const viewer = await getServerViewer(setup);
  if (!viewer) throw new SourceError("Sign in to view project files.", 401);
  // Local and password modes represent one trusted project operator. OAuth needs explicit membership.
  if (
    setup.authMode === "vercel" &&
    !(process.env.TOMOK_PROJECT_VIEWER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .includes(viewer.id)
  ) {
    throw new SourceError("You do not have access to this project.", 403);
  }
  return viewer;
}
export function fileError(error: unknown) {
  if (!(error instanceof SourceError))
    console.error("Project file request failed", error);
  return Response.json(
    {
      error:
        error instanceof SourceError
          ? error.message
          : "Unable to read this source file.",
    },
    {
      status: error instanceof SourceError ? error.status : 500,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
