import { projectFiles } from "@/lib/project-files/catalog";
import { fileError, requireProjectAccess } from "@/lib/project-files/access";
export async function GET() {
  try {
    await requireProjectAccess();
    return Response.json(
      { project: "B&P / Frederick Douglass Tunnel", files: projectFiles },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return fileError(error);
  }
}
