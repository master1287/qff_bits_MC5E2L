import { createInvite, respond } from "@/lib/rooms";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => createInvite(request, (await context.params).id));
}
