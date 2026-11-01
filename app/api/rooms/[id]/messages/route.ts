import { sendMessage, respond } from "@/lib/rooms";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => sendMessage(request, (await context.params).id));
}
