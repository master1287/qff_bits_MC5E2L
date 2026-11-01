import { quantumResponse, quantumStatus } from "@/lib/ibm-quantum";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return quantumResponse(() => quantumStatus(request)); }
