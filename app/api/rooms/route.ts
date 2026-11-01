import { createRoom, respond } from "@/lib/rooms";
export async function POST(request: Request) { return respond(() => createRoom(request)); }
