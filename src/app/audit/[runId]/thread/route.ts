import { getSample } from "@/lib/referee/data";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const sampleId = new URL(request.url).searchParams.get("sample");
  if (!sampleId) return Response.json({ error: "Missing sample" }, { status: 400 });

  const sample = await getSample(runId, sampleId);
  if (!sample) return Response.json({ error: "Unknown sample" }, { status: 404 });

  return Response.json(sample, { headers: { "Cache-Control": "no-store" } });
}
