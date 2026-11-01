import { getRoom, respond } from "@/lib/rooms";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => getRoom(request, (await context.params).id));
}
