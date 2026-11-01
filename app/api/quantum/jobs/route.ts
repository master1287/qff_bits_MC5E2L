import { quantumResponse, startHardwareJob } from "@/lib/ibm-quantum";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return quantumResponse(() => startHardwareJob(request)); }
