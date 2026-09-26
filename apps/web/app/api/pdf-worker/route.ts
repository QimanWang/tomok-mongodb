import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export async function GET() {
  const resolvePackage = createRequire(path.join(process.cwd(), "package.json"));
  const worker = await readFile(
    resolvePackage.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
  );
  return new Response(worker, {
    headers: {
      "Content-Type": "text/javascript",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
