import { getRun, runVersion, type SampleView } from "@/lib/referee/data";

export const dynamic = "force-dynamic";

export type ThreadResponse = {
  sample: SampleView;
  /** Covers every sample's status and turn count, so the client can tell when
   * the sample list and the coverage ring have gone stale too. */
  runVersion: string;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const sampleId = new URL(request.url).searchParams.get("sample");
  if (!sampleId) return Response.json({ error: "Missing sample" }, { status: 400 });

  let run: Awaited<ReturnType<typeof getRun>>;
  try {
    run = await getRun(runId);
  } catch (error) {
    console.error("[referee] polling a thread failed", { runId, sampleId, error });
    return Response.json({ error: "Unavailable" }, { status: 500 });
  }
  if (!run) return Response.json({ error: "Unknown run" }, { status: 404 });

  const sample = run.samples.find((s) => s.id === sampleId);
  if (!sample) return Response.json({ error: "Unknown sample" }, { status: 404 });

  const body: ThreadResponse = { sample, runVersion: runVersion(run) };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
