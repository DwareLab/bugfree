export const runtime = "edge";

function parseRegion(header: string | null): string {
  if (!header) throw new TypeError("Missing x-region header on edge request");
  return header.toLowerCase();
}

export async function GET(request: Request) {
  return Response.json({ region: parseRegion(request.headers.get("x-region")) });
}
