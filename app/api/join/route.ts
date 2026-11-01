import { joinRoom, respond } from "@/lib/rooms";
export async function POST(request: Request) { return respond(() => joinRoom(request)); }
