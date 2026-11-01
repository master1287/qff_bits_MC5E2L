import { callQiskit, hasLiveQiskit } from "@/lib/qiskit-client";
import replays from "@/public/qiskit-replays.json";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  const selected = new URL(request.url).searchParams.get("intercept") ?? "0";
  if (!["0", "1"].includes(selected)) return Response.json({ error: "Choose intercept=0 or intercept=1." }, { status: 400, headers });
  const intercept = selected === "1";
  try {
    const live = hasLiveQiskit();
    const data = live ? await callQiskit("/lesson", { intercept }) : replays.scenarios[intercept ? "intercept" : "clean"];
    if (data.engine !== "qiskit-statevector" || data.intercept !== intercept || !Array.isArray(data.rows) || data.rows.length !== 5) {
      throw new Error("Invalid five-qubit Qiskit result.");
    }
    return Response.json({ ...data, execution: live ? "live" : "replay",
      sourceLabel: live ? "Live Qiskit service" : "Qiskit-generated replay",
    }, { headers });
  } catch {
    return Response.json({ error: "The Qiskit lesson is unavailable. Check the Python service connection or try again." }, { status: 503, headers });
  }
}
