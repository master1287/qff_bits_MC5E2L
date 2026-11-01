import { hardwareJob, quantumResponse } from "@/lib/ibm-quantum";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return quantumResponse(() => hardwareJob(request, id));
}
