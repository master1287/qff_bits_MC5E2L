import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const root = process.cwd();
const candidates = process.platform === "win32"
  ? [".venv/Scripts/python.exe", ".sites-runtime/qiskit-venv/Scripts/python.exe"]
  : [".venv/bin/python", ".sites-runtime/qiskit-venv/bin/python"];
const python = process.env.QISKIT_PYTHON || candidates.map(p => path.join(root, p)).find(existsSync);
if (!python) throw new Error("Create a Python environment first: python -m venv .venv, then install qiskit_service/requirements.txt into it.");
const config = path.join(root, ".dev.vars");
let vars = existsSync(config) ? readFileSync(config, "utf8") : "";
function setLocal(name, value) {
  const matcher = new RegExp(`^${name}=.*$`, "m");
  vars = matcher.test(vars) ? vars.replace(matcher, () => `${name}=${value}`) : vars.trimEnd() + `\n${name}=${value}\n`;
}
if (!/^CHAT_MASTER_KEY=.+$/m.test(vars)) setLocal("CHAT_MASTER_KEY", randomBytes(32).toString("base64url"));
const existingToken = vars.match(/^QISKIT_SERVICE_TOKEN=(.+)$/m)?.[1]?.trim();
const token = existingToken || randomBytes(32).toString("base64url");
setLocal("QISKIT_SERVICE_TOKEN", token);
setLocal("QISKIT_SERVICE_URL", "http://127.0.0.1:8001");
writeFileSync(config, vars);
const service = spawn(python, ["-m", "qiskit_service.server"], {
  cwd: root, stdio: "inherit", env: { ...process.env, PYTHONUNBUFFERED: "1", QISKIT_SERVICE_TOKEN: token, QISKIT_HOST: "127.0.0.1", QISKIT_PORT: "8001" },
});
service.on("error", () => { console.error("Could not start Python. Check QISKIT_PYTHON and the Python dependencies."); stop(1); });
// Wrangler reads the local .dev.vars file; none of these secrets enters source.
const app = spawn(process.execPath, ["scripts/run-framework.mjs", "dev"], { cwd: root, stdio: "inherit" });
app.on("error", () => { console.error("Could not start the local app."); stop(1); });
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true;
  app.kill(); service.kill(); process.exitCode = code;
}
service.on("exit", code => stop(code || 0));
app.on("exit", code => stop(code || 0));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
console.log("Starting local Qiskit service on 127.0.0.1:8001 and the messaging app. No IBM account is needed for this simulator.");
