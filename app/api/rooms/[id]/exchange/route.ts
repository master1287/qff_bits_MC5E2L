import { exchangeKey, respond } from "@/lib/rooms";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => exchangeKey(request, (await context.params).id));
}
