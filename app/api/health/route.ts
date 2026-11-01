import { health, respond } from "@/lib/rooms";
export const dynamic = "force-dynamic";
export async function GET() { return respond(health); }
