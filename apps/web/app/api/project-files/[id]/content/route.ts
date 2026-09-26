import { readSource } from "@/lib/project-files/catalog";
import { fileError, requireProjectAccess } from "@/lib/project-files/access";
import { parseByteRange } from "@/lib/project-files/range";
const mime = {
  xer: "text/plain",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireProjectAccess();
    const { file, bytes } = await readSource((await params).id);
    const headers = new Headers({
      "Content-Type": mime[file.kind],
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${new URL(request.url).searchParams.has("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    });
    let range;
    try {
      range = parseByteRange(request.headers.get("range"), bytes.length);
    } catch {
      headers.set("Content-Range", `bytes */${bytes.length}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      headers.set(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${bytes.length}`,
      );
      headers.set("Content-Length", String(range.end - range.start + 1));
      return new Response(
        new Uint8Array(bytes.subarray(range.start, range.end + 1)),
        { status: 206, headers },
      );
    }
    headers.set("Content-Length", String(bytes.length));
    return new Response(new Uint8Array(bytes), { headers });
  } catch (error) {
    return fileError(error);
  }
}
