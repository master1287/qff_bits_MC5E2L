"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Cpu, Eye, FlaskConical, LoaderCircle, Pause, Play, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react";

export type QuantumStatus = { configured: boolean; provider?: string; plan?: string; backend?: string; canSubmit: boolean; reason?: string; activeJobId?: string };
type Basis = "Z" | "X";
type Qubit = { index: number; aliceBit: number; aliceBasis: Basis; aliceState: string; aliceGates: string[]; eveBasis: Basis | null; eveBit: number | null; eveState: string | null; bobBasis: Basis; bobBit: number; bobState: string; basisMatches: boolean; bitMatches: boolean; sampled: boolean };
type Lesson = { id: string; engine: string; execution: string; sourceLabel: string; qiskitVersion?: string; backend?: string; jobId?: string; intercept: boolean; curated: boolean; rows: Qubit[]; circuit: string; statistics: { sent: number; sifted: number; sampled: number; errors: number; qber: number; detected: boolean; remainingBits: number[] } };
type HardwareJob = { id: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; backend?: string; shots?: number; error?: string; lesson?: Lesson };
const chapters = ["Alice’s bits", "Encode", "The channel", "Bob measures", "Sift bases", "Compare sample", "The verdict"];
const narrations = [
  ["Five ordinary bits. A quantum beginning.", "Alice starts with five bits. These public teaching values are separate from your conversation’s secret key."],
  ["A basis tells the qubit how to carry its bit.", "Z encodes 0 as |0⟩ and 1 as |1⟩. X encodes 0 as |+⟩ and 1 as |−⟩. Alice chooses a basis for each bit."],
  ["Follow the state through the channel.", "Without an interceptor, Alice’s prepared state travels directly to Bob. Eve has to guess a measurement basis."],
  ["Bob makes his own choice.", "Bob independently chooses Z or X. Matching the incoming state’s basis gives a definite result; a different basis gives a random result."],
  ["Announce the bases. Keep the matches.", "Alice and Bob compare their bases, then discard positions where they differ. They do not announce the bits they intend to keep secret."],
  ["Reveal a sample, then sacrifice it.", "Alice and Bob compare the selected matching-basis bits. Every publicly revealed bit is discarded, even when it agrees."],
  ["Inspect the sample before trusting the exchange.", "A disagreement reveals disturbance. It can come from an interceptor or hardware noise; it does not identify a person."],
];

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", cache: "no-store", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error || "The quantum experiment could not be completed.");
  return value;
}

export default function StartupWalkthrough({ onComplete, onBack, finishLabel = "Start conversation", quantumStatus, finishing = false }: { onComplete: () => void; onBack: () => void; finishLabel?: string; quantumStatus: QuantumStatus | null; finishing?: boolean }) {
  const [attack, setAttack] = useState(false);
  const [mode, setMode] = useState<"choose" | "simulation" | "hardware">("choose");
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [job, setJob] = useState<HardwareJob | null>(null);
  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);
  const [circuit, setCircuit] = useState(false);
  const [finishedJobs, setFinishedJobs] = useState<string[]>([]);

  useEffect(() => {
    if (mode !== "simulation") return;
    let cancelled = false;
    setLoading(true); setLesson(null); setStage(0); setPlaying(false); setError("");
    request<Lesson>(`/api/lesson?intercept=${attack ? 1 : 0}`).then(value => {
      if (value.rows?.length !== 5) throw new Error("The teaching sample must contain five qubits.");
      if (!cancelled) setLesson(value);
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "The simulation could not load."); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mode, attack]);
  useEffect(() => {
    if (mode !== "hardware" || !job?.id || ["completed", "failed", "cancelled"].includes(job.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const value = await request<HardwareJob>(`/api/quantum/jobs/${encodeURIComponent(job.id)}`);
        if (cancelled) return;
        setJob(value); setError("");
        if (value.status === "completed" && value.lesson) { setLesson(value.lesson); setAttack(value.lesson.intercept); setStage(0); setLoading(false); setFinishedJobs(previous => [...previous, value.id]); }
        else if (["failed", "cancelled"].includes(value.status)) { setLoading(false); setFinishedJobs(previous => [...previous, value.id]); setError(value.error || "The hardware job did not complete. You can try the Qiskit simulation instead."); }
      } catch (e) { if (!cancelled) { setLoading(false); setError(e instanceof Error ? e.message : "Could not check the hardware job."); } }
    };
    const timer = setInterval(() => void poll(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [mode, job?.id, job?.status]);
  useEffect(() => {
    if (!playing || !lesson) return;
    if (stage === 6) { setPlaying(false); return; }
    const timer = setTimeout(() => setStage(value => Math.min(6, value + 1)), 3800 / speed);
    return () => clearTimeout(timer);
  }, [playing, stage, speed, lesson]);
  useEffect(() => {
    const hide = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);

  async function startHardware() {
    if (!quantumStatus?.canSubmit || loading) return;
    setMode("hardware"); setLoading(true); setLesson(null); setJob(null); setPlaying(false); setStage(0); setError("");
    try { setJob(await request<HardwareJob>("/api/quantum/jobs", { intercept: attack })); }
    catch (e) { setLoading(false); setError(e instanceof Error ? e.message : "IBM Quantum could not accept the job."); }
  }
  function changeAttack(value: boolean) {
    setAttack(value); setPlaying(false); setStage(0); setSelected(0); setCircuit(false); setError("");
    if (mode === "hardware") { setLesson(null); setJob(null); setMode("choose"); }
  }
  function jump(value: number) { setPlaying(false); setStage(Math.max(0, Math.min(6, value))); }
  const resumeId = job && !["completed", "failed", "cancelled"].includes(job.status) ? job.id : quantumStatus?.activeJobId && !finishedJobs.includes(quantumStatus.activeJobId) ? quantumStatus.activeJobId : undefined;
  function resumeHardware() {
    if (!resumeId) return;
    setMode("hardware"); setJob({ id: resumeId, status: "queued", backend: job?.backend || quantumStatus?.backend }); setLesson(null); setLoading(true); setError(""); setStage(0); setPlaying(false);
  }
  const pending = mode === "hardware" && Boolean(job) && !["completed", "failed", "cancelled"].includes(job!.status);
  const q = lesson?.rows[selected];
  const hardware = lesson?.execution === "hardware" || lesson?.engine === "ibm-quantum-hardware";
  const stats = lesson?.statistics;
  const observedError = Boolean(stats?.errors);

  return <div className="startup-walkthrough" inert={finishing} aria-busy={finishing}>
    <div className="startup-heading"><div><span className="eyebrow">02 / SEE THE EXCHANGE</span><h2>Before the first hello.</h2><p>Follow five teaching qubits, right here in your chat.</p></div><button className="text-button" onClick={onBack}><ArrowLeft size={14}/>Back</button></div>
    <div className="experiment-options"><div className="experiment-label"><span className="mini-pulse"/><strong>{lesson ? hardware ? "IBM Quantum hardware" : lesson.sourceLabel : "CHOOSE YOUR EXPERIMENT"}</strong>{lesson && <small>{hardware ? lesson.backend : lesson.qiskitVersion ? `Qiskit ${lesson.qiskitVersion}` : "Statevector simulator"}</small>}</div><label className="eve-switch"><Eye size={15}/><span>Add Eve</span><input type="checkbox" role="switch" aria-label="Enable Eve’s intercept-resend attack" checked={attack} disabled={pending} onChange={e => changeAttack(e.target.checked)}/><i aria-hidden="true"/></label></div>
    {mode === "choose" && <div className="experiment-choice"><div className="experiment-choice-icon"><Cpu size={25}/></div><h3>A real processor, or a guided simulation?</h3><p>IBM runs these five teaching qubits on one quantum processor. This demonstrates the protocol; it is not a physical quantum channel between you and your partner.</p><div className="experiment-choice-actions"><button className="primary-button" onClick={() => resumeId ? resumeHardware() : void startHardware()} disabled={!resumeId && !quantumStatus?.canSubmit}><Cpu size={16}/>{resumeId ? "Resume IBM job" : "Run on IBM quantum computer"}<ArrowRight size={16}/></button><button className="secondary-button" onClick={() => setMode("simulation")}><FlaskConical size={15}/>Use Qiskit simulation instead</button>{!quantumStatus?.canSubmit && quantumStatus?.reason?.includes("Sign in to this site") && <a className="secondary-button" target="_top" href="/signin-with-chatgpt?return_to=%2F">Sign in with ChatGPT<ArrowRight size={15}/></a>}</div><small>{quantumStatus?.canSubmit ? "Hardware execution uses your IBM allocation: 128 shots, with a maximum execution time of 60 seconds. Queue time can vary." : quantumStatus?.reason || "Checking the IBM Quantum connection. The Qiskit simulation is available independently."}</small></div>}
    {error && <div className="error-banner" role="alert"><ShieldAlert size={16}/>{error}</div>}
    {(loading || pending) && !lesson && <div className="experiment-wait" role="status"><LoaderCircle size={30} className="spin"/><h3>{mode === "hardware" ? job?.status === "running" ? "Your qubits are on the processor." : "Waiting for IBM Quantum." : "Preparing the teaching sample."}</h3><p>{mode === "hardware" ? `${job?.backend || quantumStatus?.backend || "IBM Quantum"} · ${job?.status || "submitting"}` : "Loading results generated by Qiskit circuits."}</p>{job && <code>Job {job.id}</code>}{mode === "hardware" && <><p className="subtle-copy">You can continue with a simulation while the hardware job runs.</p><button className="secondary-button" onClick={() => { setLoading(false); setMode("simulation"); }}>Use Qiskit simulation instead</button></>}</div>}
    {!loading && !pending && error && !lesson && mode !== "choose" && <div className="experiment-retry"><button className="secondary-button" onClick={() => { setError(""); setMode("choose"); }}>Choose experiment again</button></div>}
    {lesson && mode === "simulation" && resumeId && <button className="check-hardware-job text-button" onClick={resumeHardware}><Cpu size={14}/>Check IBM job<ArrowRight size={13}/></button>}
    {lesson && <>
      <div className="inline-channel" aria-label="Alice to Bob quantum channel"><div className="channel-person"><span>A</span><div><strong>Alice</strong><small>Prepares</small></div></div><div className={`photon-track ${playing ? "moving" : ""}`} aria-hidden="true">{lesson.rows.map((row, i) => <i key={row.index} style={{ "--photon-index": i } as React.CSSProperties}>{stage >= 1 ? row.aliceBasis : row.aliceBit}</i>)}<ArrowRight size={15}/></div>{attack && <><div className="channel-person eve"><span><Eye size={20}/></span><div><strong>Eve</strong><small>Measures & resends</small></div></div><div className={`photon-track after-eve ${playing ? "moving" : ""}`} aria-hidden="true">{lesson.rows.map((row, i) => <i key={row.index} style={{ "--photon-index": i } as React.CSSProperties}>{stage >= 2 ? row.eveBasis : "?"}</i>)}<ArrowRight size={15}/></div></>}<div className="channel-person"><span>B</span><div><strong>Bob</strong><small>Measures</small></div></div></div>
      <div className="walkthrough-narration" aria-live="polite" aria-atomic="true"><span>{String(stage + 1).padStart(2, "0")}</span><div><h3>{stage === 6 ? observedError ? "The sample reveals disturbance." : "No disturbance in this sample." : narrations[stage][0]}</h3><p>{stage === 6 ? observedError ? `${stats?.errors} of ${stats?.sampled} disclosed bits disagree. ${hardware ? "Hardware noise can also cause errors; this does not prove Eve was present." : "The example illustrates why an intercepted exchange can be rejected."}` : "The disclosed bits agree. A five-qubit sample is an illustration, not proof that an exchange is safe." : stage === 2 && attack ? "Eve guesses a basis, measures, and resends the state she obtained. A wrong basis changes the quantum state and can change Bob’s result." : narrations[stage][1]}</p></div></div>
      <nav className="inline-chapters" aria-label="Exchange explanation steps">{chapters.map((chapter, index) => <button key={chapter} aria-current={stage === index ? "step" : undefined} className={stage === index ? "current" : index < stage ? "complete" : ""} onClick={() => jump(index)}><span>{index < stage ? <Check size={11}/> : index + 1}</span>{chapter}</button>)}</nav>
      <div className="inline-controls"><button className="play-button" onClick={() => { if (stage === 6) setStage(0); setPlaying(value => !value); }} aria-label={playing ? "Pause explanation" : "Play explanation"}>{playing ? <Pause size={16} fill="currentColor"/> : <Play size={16} fill="currentColor"/>}</button><button className="icon-button" aria-label="Previous explanation step" disabled={stage === 0} onClick={() => jump(stage - 1)}><ArrowLeft size={16}/></button><button className="icon-button" aria-label="Next explanation step" disabled={stage === 6} onClick={() => jump(stage + 1)}><ArrowRight size={16}/></button><span className="step-counter">{stage + 1} / 7</span><label className="playback-speed"><span>Speed</span><select aria-label="Explanation playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option></select></label><button className="icon-button" aria-label="Restart explanation" onClick={() => jump(0)}><RotateCcw size={15}/></button></div>
      <div className="sample-board" role="region" aria-label="Five teaching qubits" tabIndex={0}><table><thead><tr><th>THE FIVE-QUBIT SAMPLE</th>{lesson.rows.map((row, index) => <th key={row.index}><button aria-label={`Inspect qubit ${row.index}`} aria-pressed={selected === index} onClick={() => setSelected(index)}>q{row.index}</button></th>)}</tr></thead><tbody>
        <tr><th>Alice’s bit</th>{lesson.rows.map(row => <td key={row.index}>{row.aliceBit}</td>)}</tr>
        <tr><th>Alice’s basis</th>{lesson.rows.map(row => <td key={row.index}>{stage >= 1 ? <span className="basis-pill">{row.aliceBasis}</span> : <span className="unrevealed">—</span>}</td>)}</tr>
        <tr><th>State prepared</th>{lesson.rows.map(row => <td key={row.index}><code>{stage >= 1 ? row.aliceState : "—"}</code></td>)}</tr>
        {attack && <><tr className="eve-row"><th>Eve’s basis / bit</th>{lesson.rows.map(row => <td key={row.index}>{stage >= 2 ? <>{row.eveBasis}<span className="value-divider">/</span>{row.eveBit}</> : <span className="unrevealed">—</span>}</td>)}</tr><tr className="eve-row"><th>State resent</th>{lesson.rows.map(row => <td key={row.index} className={stage >= 2 && row.eveState !== row.aliceState ? "changed-state" : ""}><code>{stage >= 2 ? row.eveState : "—"}</code></td>)}</tr></>}
        <tr><th>Bob’s basis / bit</th>{lesson.rows.map(row => <td key={row.index}>{stage >= 3 ? <>{row.bobBasis}<span className="value-divider">/</span>{row.bobBit}</> : <span className="unrevealed">—</span>}</td>)}</tr>
        <tr><th>Bob’s measured state</th>{lesson.rows.map(row => <td key={row.index}><code>{stage >= 3 ? row.bobState : "—"}</code></td>)}</tr>
        <tr><th>Compare bases</th>{lesson.rows.map(row => <td key={row.index}>{stage >= 4 ? <span className={`sample-status ${row.basisMatches ? "keep" : "discard"}`}>{row.basisMatches ? "Keep" : "Discard"}</span> : <span className="unrevealed">—</span>}</td>)}</tr>
        <tr><th>Public sample</th>{lesson.rows.map(row => <td key={row.index}>{stage >= 5 ? !row.basisMatches ? <span className="unrevealed">Discarded</span> : row.sampled ? <span className={`sample-check ${row.bitMatches ? "agree" : "error"}`}>{row.aliceBit} {row.bitMatches ? "=" : "≠"} {row.bobBit}<small>{row.bitMatches ? "Agree" : "Error"} · discard</small></span> : <span className="sample-status">Not sampled</span> : <span className="unrevealed">—</span>}</td>)}</tr>
      </tbody></table></div>
      {q && <div className="qubit-inspector"><span className="qubit-tag">q{q.index}</span><div><strong>{stage >= 1 ? `${q.aliceBit} → ${q.aliceState}` : `Alice’s input: ${q.aliceBit}`}</strong><p>{stage < 1 ? "The basis and prepared state appear in the next step." : stage < 3 ? `Alice applies ${q.aliceGates.length ? q.aliceGates.join(" → ") : "I (no gate)"}. ${attack && stage >= 2 ? `Eve measures in ${q.eveBasis} and resends ${q.eveState}.` : "X flips the bit; H changes between Z and X bases."}` : stage >= 5 && q.sampled && !q.bitMatches ? "Matching bases, different disclosed bits: this position reveals disturbance." : `Bob measures in ${q.bobBasis} and obtains ${q.bobBit}. ${q.basisMatches ? "This position survives basis sifting." : "The bases differ, so this position is discarded even if the bits happen to agree."}`}</p></div></div>}
      <div className={`inline-verdict ${stage === 6 && observedError ? "disturbance" : ""}`}><span>{stage === 6 ? observedError ? <ShieldAlert size={20}/> : <ShieldCheck size={20}/> : <FlaskConical size={20}/>}</span><div><strong>{stage < 6 ? "Keep going to reveal the sample check." : observedError ? "Disturbance observed · candidate exchange rejected" : "Sample agrees · not a security guarantee"}</strong><p>{stage >= 5 ? `${stats?.sifted} matching bases · ${stats?.sampled} disclosed bits · ${((stats?.qber || 0) * 100).toFixed(0)}% sample errors` : "Five teaching qubits, separate from your secret conversation key."}</p></div></div>
      <p className="experiment-footnote">{hardware ? "Executed on a real IBM quantum processor. One processor simulates both endpoints; this is not physical QKD between remote people. Hardware noise can produce errors." : lesson.curated && attack ? "This Qiskit example is selected to illustrate detection. Other five-qubit samples can miss Eve." : "A Qiskit simulation of the protocol; no real quantum hardware was used for this example."} Publicly revealed bits are discarded. These five values never become your chat key.</p>
      <details className="inline-circuit" open={circuit} onToggle={e => setCircuit(e.currentTarget.open)}><summary>Inspect the {hardware ? "hardware" : "Qiskit"} circuit<ChevronDown size={15}/></summary><pre>{lesson.circuit}</pre></details>
      <div className="walkthrough-finish"><span>{stage === 6 ? "You’ve seen how the sample is checked." : "Complete the explanation to open the conversation."}</span><button className="primary-button" disabled={stage !== 6} onClick={onComplete}>{finishLabel}<ArrowRight size={16}/></button></div>
    </>}
  </div>;
}
