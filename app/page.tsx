"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Atom, Check, CheckCheck, ChevronRight, Copy, Cpu, Eye, EyeOff, FlaskConical, Link2, LoaderCircle, LockKeyhole, Menu, MessageCircle, Plus, RefreshCw, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import { planDetectionConfidence, type DetectionPlan } from "@/lib/security-plan.mjs";
import StartupWalkthrough, { type QuantumStatus } from "./components/startup-walkthrough";

type Role = "alice" | "bob";
type Session = { roomId: string; token: string; role: Role; name: string };
type Transcript = { exchangeId: string; keyBits: number; fingerprint: string | null; engine?: string; qubits: number; sampledBits: number; qber: number; threshold: number; status: string };
type Message = { id: string; role: Role; displayName: string; text: string; createdAt: string; ciphertext: string; iv: string; exchangeId: string };
type Room = { id: string; name: string; role: Role; aliceName: string; bobName: string | null; createdAt: string; activeExchange: Transcript | null; latestAttempt: Transcript | null; securityPlan?: DetectionPlan | null; messages: Message[] };
type View = "welcome" | "setup" | "walkthrough" | "chat" | "join";
type StartupPurpose = "create" | "join" | "inspect";
const storageKey = "qubit.rooms.v1";
const keyOf = (value: Session) => `${value.roomId}:${value.role}`;
const initials = (value: string) => value.trim().slice(0, 1).toUpperCase() || "Q";
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

async function api<T>(path: string, options: { token?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, { method: options.body === undefined ? "GET" : "POST", cache: "no-store", headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error("The server could not complete this request. Please try again."); }
  if (!response.ok) { const error = value && typeof value === "object" && "error" in value ? value.error : null; throw new Error(typeof error === "string" ? error : "The request could not be completed."); }
  return value as T;
}

export default function Home() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [view, setView] = useState<View>("welcome");
  const [purpose, setPurpose] = useState<StartupPurpose>("create");
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [quantumStatus, setQuantumStatus] = useState<QuantumStatus | null>(null);
  const [query, setQuery] = useState("");
  const [roomName, setRoomName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [confidence, setConfidence] = useState("99");
  const [inviteToken, setInviteToken] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [roomLoadError, setRoomLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const [cipher, setCipher] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const activeRef = useRef("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const active = sessions.find(value => keyOf(value) === activeKey);
  activeRef.current = activeKey;
  const transcript = room?.activeExchange;
  let plan: DetectionPlan | null = null;
  let planError = "";
  try { plan = planDetectionConfidence(Number(confidence)); } catch (e) { planError = e instanceof Error ? e.message : "Choose a percentage between 50 and 99.9999."; }

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) || "[]");
      if (Array.isArray(saved)) {
        const valid = saved.filter((value): value is Session => value && typeof value.roomId === "string" && typeof value.token === "string" && typeof value.name === "string" && ["alice", "bob"].includes(value.role)).slice(0, 50);
        setSessions(valid); if (valid[0]) { setActiveKey(keyOf(valid[0])); setView("chat"); }
      }
    } catch { /* A room token can remain in this tab when storage is unavailable. */ }
    const invitation = new URLSearchParams(location.hash.slice(1)).get("invite");
    if (invitation) { setInviteToken(invitation); setView("join"); history.replaceState(null, "", location.pathname + location.search); }
    setReady(true);
    const check = () => {
      void api<{ ok: boolean }>("/api/health").then(value => setOnline(Boolean(value.ok))).catch(() => setOnline(false));
      void api<QuantumStatus>("/api/quantum/status").then(setQuantumStatus).catch(() => setQuantumStatus({ configured: false, canSubmit: false, reason: "The IBM Quantum connection could not be checked. The Qiskit simulation remains available." }));
    };
    check(); const timer = setInterval(check, 30000); return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(storageKey, JSON.stringify(sessions)); } catch { /* Current-tab access continues without browser storage. */ }
  }, [sessions, ready]);
  useEffect(() => {
    if (!active) { setRoom(null); return; }
    let cancelled = false;
    setRoom(null); setText(""); setCipher(false); setError(""); setRoomLoadError("");
    const update = async () => {
      try { const value = await api<Room>(`/api/rooms/${active.roomId}`, { token: active.token }); if (!cancelled) { setRoom(value); setOnline(true); setRoomLoadError(""); } }
      catch (e) { if (!cancelled) setRoomLoadError(e instanceof Error ? e.message : "Could not load this conversation."); }
    };
    void update(); const timer = setInterval(update, 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeKey, active?.token]);
  useEffect(() => { if (view === "chat") endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [room?.messages.length, view]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 6500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (!inviteOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handle = requestAnimationFrame(() => modalRef.current?.querySelector<HTMLElement>("input")?.focus());
    const oldOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInviteOpen(false);
      if (event.key !== "Tab") return;
      const values = Array.from(modalRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled)") || []);
      if (event.shiftKey && document.activeElement === values[0]) { event.preventDefault(); values.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === values.at(-1)) { event.preventDefault(); values[0]?.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => { cancelAnimationFrame(handle); document.removeEventListener("keydown", keyboard); document.body.style.overflow = oldOverflow; if (previous?.isConnected) previous.focus(); };
  }, [inviteOpen]);

  function saveSession(value: { roomId: string; token: string; role: Role }, name: string) {
    const item: Session = { roomId: value.roomId, token: value.token, role: value.role, name };
    setSessions(previous => [item, ...previous.filter(saved => keyOf(saved) !== keyOf(item))]);
    setActiveKey(keyOf(item)); setMobileSidebar(false);
  }
  function newConversation() { setRoomName(""); setDisplayName(""); setConfidence("99"); setError(""); setNotice(""); setPurpose("create"); setView("setup"); setMobileSidebar(false); }
  function backToRoom() { setError(""); setView(active ? "chat" : "welcome"); }
  function beginExplanation(event: FormEvent) { event.preventDefault(); if (!plan) return; setError(""); setPurpose("create"); setView("walkthrough"); }
  function beginJoin(event: FormEvent) { event.preventDefault(); setError(""); setPurpose("join"); setView("walkthrough"); }
  async function finishExplanation() {
    if (busy) return;
    if (purpose === "inspect") { setView("chat"); return; }
    setBusy("create"); setError("");
    try {
      if (purpose === "join") {
        const value = await api<Session>("/api/join", { body: { inviteToken, displayName: displayName.trim() } });
        saveSession(value, "Joined conversation"); setInviteToken(""); setView("chat");
        const loaded = await api<Room>(`/api/rooms/${value.roomId}`, { token: value.token });
        saveSession(value, loaded.name); setNotice("You joined the conversation.");
      } else {
        if (!plan) throw new Error("Choose a valid detection confidence first.");
        const value = await api<Session & { inviteToken: string }>("/api/rooms", { body: { name: roomName.trim(), displayName: displayName.trim(), detectionConfidence: plan.requestedPercent } });
        saveSession(value, roomName.trim()); setView("chat"); setCopied(false);
        setInviteUrl(`${location.origin}/#invite=${encodeURIComponent(value.inviteToken)}`); setInviteOpen(true);
        setNotice("Your exchange is complete. Invite your conversation partner.");
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not start the conversation."); } finally { setBusy(""); }
  }
  async function refresh() {
    if (!active) return;
    const captured = keyOf(active);
    const value = await api<Room>(`/api/rooms/${active.roomId}`, { token: active.token });
    if (captured === activeRef.current) setRoom(value);
  }
  async function invite() {
    if (!active) return; setBusy("invite"); setError("");
    try { const value = await api<{ inviteToken: string }>(`/api/rooms/${active.roomId}/invite`, { token: active.token, body: {} }); setInviteUrl(`${location.origin}/#invite=${encodeURIComponent(value.inviteToken)}`); setCopied(false); setInviteOpen(true); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not create an invitation."); } finally { setBusy(""); }
  }
  async function send(event: FormEvent) {
    event.preventDefault(); if (!active || !transcript || !text.trim() || busy) return;
    setBusy("send"); setError("");
    try { await api(`/api/rooms/${active.roomId}/messages`, { token: active.token, body: { text: text.trim(), exchangeId: transcript.exchangeId } }); setText(""); await refresh(); composerRef.current?.focus(); }
    catch (e) { setError(e instanceof Error ? e.message : "Your message could not be sent."); } finally { setBusy(""); }
  }
  async function rotate() {
    if (!active || busy) return; setBusy("rotate"); setError("");
    try { const value = await api<{ accepted: boolean }>(`/api/rooms/${active.roomId}/exchange`, { token: active.token, body: { intercept: false } }); await refresh(); setNotice(value.accepted ? "A new conversation key is ready. Earlier messages remain readable." : "This candidate exchange was rejected. The previous key is still active."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not rotate the conversation key."); } finally { setBusy(""); }
  }
  async function copyInvite() {
    try { await navigator.clipboard.writeText(inviteUrl); setCopied(true); } catch { setNotice("Select and copy the invitation link to share it."); }
  }
  const preparing = ["setup", "walkthrough", "join"].includes(view);
  const quantumLabel = quantumStatus?.canSubmit ? "IBM Quantum ready" : quantumStatus?.configured ? "IBM connected" : "IBM connection";

  return <div className="qubit-app">
    <header className="global-header"><a href="/" className="brand" aria-label="Qubit home"><Atom size={28} strokeWidth={1.7}/><span>qubit<span>.</span></span><small>BB84 MESSENGER</small></a><div className="header-status"><span className={`connection ${online === false ? "offline" : ""}`}><i/>{online === null ? "Connecting" : online ? "Backend connected" : "Backend unavailable"}</span><span className={`quantum-chip ${quantumStatus?.canSubmit ? "ready" : ""}`}><Cpu size={14}/>{quantumLabel}</span></div></header>
    <main className={`messenger-shell ${mobileSidebar ? "show-sidebar" : ""}`}>
      <aside className="conversation-sidebar"><div className="sidebar-heading"><span className="eyebrow">YOUR WORKSPACE</span><button className="icon-button mobile-only" aria-label="Close conversations" onClick={() => setMobileSidebar(false)}><X size={18}/></button></div><h1>Conversations<span>.</span></h1><button className="primary-button new-conversation" onClick={newConversation}><Plus size={17}/>New conversation</button><label className="search-field"><Search size={15}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a conversation" aria-label="Search conversations"/></label><div className="sidebar-section-label">MESSAGES <span>{sessions.length}</span></div><div className="conversation-list">{sessions.filter(value => value.name.toLowerCase().includes(query.toLowerCase())).map(value => <button key={keyOf(value)} className={`conversation-item ${keyOf(value) === activeKey && view === "chat" ? "selected" : ""}`} onClick={() => { setActiveKey(keyOf(value)); setView("chat"); setMobileSidebar(false); setError(""); setNotice(""); }}><span className="conversation-avatar">{initials(value.name)}</span><span><strong>{value.name}</strong><small>You are {value.role === "alice" ? "Alice" : "Bob"}</small></span><ChevronRight size={14}/></button>)}{sessions.length === 0 && <div className="sidebar-empty"><MessageCircle size={24} strokeWidth={1.4}/><p>A fresh channel.</p><span>Your conversations<br/>will appear here.</span></div>}{sessions.length > 0 && !sessions.some(value => value.name.toLowerCase().includes(query.toLowerCase())) && <p className="no-results">No conversations found.</p>}</div><div className="sidebar-bottom"><ShieldCheck size={21}/><div><strong>Understand the exchange.</strong><p>Choose your detection target.<br/>Watch five qubits before you chat.</p></div></div><div className="sidebar-version"><span className="mini-pulse"/> QUANTUM CURIOUS. CLEAR BY DESIGN.</div></aside>
      <section className="chat-section" aria-label="Chat window"><div className="chat-header"><div className="chat-heading"><button className="icon-button mobile-only" aria-label="Show conversations" onClick={() => setMobileSidebar(true)}><Menu size={20}/></button><span className="chat-avatar">{view === "chat" && room ? initials(room.name) : <MessageCircle size={19}/>}</span><div><h2>{view === "chat" && room ? room.name : preparing ? view === "walkthrough" ? "Your exchange, explained" : view === "join" ? "An invitation to connect" : "A new connection" : "Your next conversation"}</h2><span>{view === "chat" && room ? room.bobName ? `${room.aliceName} & ${room.bobName}` : `${room.aliceName} · Waiting for your invitee` : "Private words. A visible beginning."}</span></div></div><div className="chat-tools">{view === "chat" && room && <><button className="text-button exchange-button" onClick={() => { setPurpose("inspect"); setView("walkthrough"); setError(""); }}><FlaskConical size={15}/><span>View exchange</span></button><button className={`icon-button ${cipher ? "is-active" : ""}`} onClick={() => setCipher(value => !value)} aria-label={cipher ? "Show readable messages" : "Show stored ciphertext"}>{cipher ? <EyeOff size={18}/> : <Eye size={18}/>}</button><button className="icon-button" onClick={() => void rotate()} disabled={Boolean(busy)} aria-label="Rotate conversation key"><RefreshCw size={17} className={busy === "rotate" ? "spin" : ""}/></button>{room.role === "alice" && !room.bobName && <button className="invite-button" onClick={() => void invite()} disabled={Boolean(busy)}><Link2 size={14}/><span>Invite</span></button>}</>}{preparing && <span className="setup-status"><span/>SETUP IN PROGRESS</span>}</div></div>
      {(error || (view === "chat" && roomLoadError)) && <div className="error-banner" role="alert">{error || roomLoadError}<button onClick={() => { setError(""); setRoomLoadError(""); }} aria-label="Dismiss error"><X size={14}/></button></div>}{notice && <div className="notice-banner" role="status"><Check size={15}/>{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notification"><X size={14}/></button></div>}
      {view === "welcome" && <div className="welcome-state"><div className="welcome-orbit" aria-hidden="true"><span className="orbit-line one"/><span className="orbit-line two"/><span className="orbit-core"><LockKeyhole size={29}/></span><i className="orbital-dot first"/><i className="orbital-dot second"/></div><span className="eyebrow">BEFORE THE FIRST HELLO</span><h2>A private chat.<br/>A visible beginning.</h2><p>Set your detection target. Follow the qubits.<br/>Then make room for a conversation.</p><button className="primary-button welcome-cta" onClick={newConversation}>Start a conversation<ArrowRight size={18}/></button><div className="welcome-features"><span><Cpu size={14}/>IBM Quantum integration</span><span><LockKeyhole size={14}/>AES-256-GCM</span></div><p className="welcome-note">A hardware demonstration or simulation of BB84.<br/>Messages are encrypted on the server; this is not end-to-end encryption.</p></div>}
      {view === "setup" && <div className="setup-scroll"><form className="confidence-setup" onSubmit={beginExplanation}><div className="setup-topline"><span className="eyebrow">01 / CHOOSE YOUR TARGET</span><button className="text-button" type="button" onClick={backToRoom}><ArrowLeft size={14}/>Back</button></div><h2>How confident<br/>should the check be?</h2><p className="setup-intro">Choose the chance of detecting a full intercept-resend attack. We’ll calculate the sample size, then show you how the exchange works.</p><div className="setup-name-fields"><label>Conversation name<input autoFocus required maxLength={60} value={roomName} onChange={e => setRoomName(e.target.value)} placeholder="e.g. Weekend plans"/></label><label>Your name<input required maxLength={40} value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="What should we call you?"/></label></div><label className="confidence-label">Chance of detecting a full intercept-resend attack<div className="confidence-input"><input aria-label="Detection confidence percentage" required type="number" min="50" max="99.9999" step="any" value={confidence} onChange={e => setConfidence(e.target.value)}/><span>%</span></div></label><div className="confidence-presets" aria-label="Detection confidence presets">{[95, 99, 99.9].map(value => <button type="button" key={value} className={Number(confidence) === value ? "selected" : ""} onClick={() => setConfidence(String(value))}>{value}%{value === 99 && <small>RECOMMENDED</small>}</button>)}</div>{plan ? <div className="plan-results" aria-live="polite"><div className="plan-primary"><span>QUBIT TRANSMISSIONS</span><strong>{plan.qubits.toLocaleString()}</strong><p>Conservative number to prepare</p></div><div><span>PUBLIC SAMPLE</span><strong>{plan.sampleBits}</strong><p>Matching-basis bits to reveal & discard</p></div><div><span>DETECTION ESTIMATE</span><strong>{plan.achievedPercent.toLocaleString(undefined, { maximumFractionDigits: 4 })}<small>%</small></strong><p>Under the stated attack model</p></div></div> : <p className="form-error" role="alert">{planError}</p>}<div className="plan-assumptions"><ShieldCheck size={18}/><p>This is a conditional estimate for an ideal BB84 channel, not the probability that your messages are safe. It assumes Eve intercepts every qubit. The transmission budget allows {plan?.siftingConfidencePercent || 99.9}% confidence of obtaining enough matching bases and retains at least 512 undisclosed bits.</p></div><details className="confidence-math"><summary>How is this calculated?<ChevronRight size={14}/></summary><p>Each publicly checked matching-basis bit has a 25% chance of revealing a full intercept-resend attack.</p><code>P(detect) = 1 − (3/4)<sup>m</sup></code><p>We choose the smallest public sample m that reaches your target, then allow extra transmissions for random basis mismatches. These are independently prepared qubit transmissions, not the number of physical qubits required at once. A finite sample cannot provide 100% certainty.</p></details><div className="setup-bottom"><span>Next: a five-qubit visual walkthrough.</span><button type="submit" className="primary-button" disabled={!plan}>See how the exchange works<ArrowRight size={17}/></button></div></form></div>}
      {view === "join" && <div className="setup-scroll"><form className="join-setup" onSubmit={beginJoin}><span className="eyebrow">YOU’RE INVITED</span><span className="join-symbol"><Link2 size={27}/></span><h2>A conversation<br/>is waiting.</h2><p>Choose your name, then follow the five-qubit introduction before joining. The room creator’s detection settings apply.</p><label>Your name<input autoFocus required maxLength={40} value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="What should we call you?"/></label><button className="primary-button" type="submit">See the exchange<ArrowRight size={16}/></button><small>Your single-use invitation is accepted only after the explanation.</small><button className="text-button" type="button" onClick={backToRoom}><ArrowLeft size={14}/>Back</button></form></div>}
      {view === "walkthrough" && <div className="setup-scroll"><div className="inline-explanation-wrap">{busy === "create" && <div className="notice-banner" role="status"><LoaderCircle className="spin" size={16}/>{purpose === "join" ? "Joining your conversation…" : "Preparing your private exchange…"}</div>}<StartupWalkthrough key={`${purpose}-${roomName}-${inviteToken ? "invite" : "new"}`} onBack={() => purpose === "create" ? setView("setup") : purpose === "join" ? setView("join") : setView("chat")} onComplete={() => void finishExplanation()} finishLabel={purpose === "inspect" ? "Return to conversation" : purpose === "join" ? "Join conversation" : "Start conversation"} quantumStatus={quantumStatus} finishing={busy === "create"}/></div></div>}
      {view === "chat" && !room && <div className="loading-state"><LoaderCircle className="spin" size={26}/><h3>Opening your conversation…</h3><p>Your room token stays on this device.</p></div>}
      {view === "chat" && room && <><div className="message-scroll"><div className="date-divider"><span>{new Date(room.createdAt).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}</span></div><div className="channel-event"><LockKeyhole size={12}/>{transcript?.keyBits || 256}-bit message key established</div>{room.messages.length === 0 && <div className="first-message"><span><Sparkles size={24}/></span><h3>Your channel is ready.</h3><p>{room.bobName ? "Say hello. Each message is encrypted before it is stored." : "Send the first hello, then invite someone to join you."}</p>{room.role === "alice" && !room.bobName && <button className="text-button" onClick={() => void invite()} disabled={Boolean(busy)}>Get invitation link<ArrowRight size={14}/></button>}</div>}{cipher && room.messages.length > 0 && <div className="cipher-notice"><Eye size={14}/>Viewing the encrypted payload stored by the backend.</div>}{room.messages.map(message => <div className={`message-row ${message.role === room.role ? "outgoing" : "incoming"}`} key={message.id}>{message.role !== room.role && <span className="message-avatar">{initials(message.displayName || "Bob")}</span>}<div className="message-content"><span className="message-author">{message.role === room.role ? "You" : message.displayName}</span><div className={`message-bubble ${cipher ? "ciphertext" : ""}`}>{cipher ? message.ciphertext : message.text}</div><div className="message-meta"><LockKeyhole size={10}/><span>{time(message.createdAt)}</span>{message.role === room.role && <CheckCheck size={13}/>}</div></div></div>)}<div ref={endRef}/></div><form className="composer" onSubmit={send}><div className="composer-input"><textarea ref={composerRef} aria-label="Message" rows={1} maxLength={4000} value={text} placeholder="A message worth keeping private…" onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(e); } }}/><button type="submit" className="send-button" aria-label="Send message" disabled={!text.trim() || !transcript || Boolean(busy)}>{busy === "send" ? <LoaderCircle className="spin" size={19}/> : <ArrowRight size={21}/>}</button></div><div className="composer-footer"><span><LockKeyhole size={11}/>AES-256-GCM · server encryption</span><span>{room.securityPlan ? `${room.securityPlan.requestedPercent}% detection target · ` : ""}{transcript?.engine === "qiskit-statevector" ? "Qiskit exchange" : "BB84 simulation"}</span></div></form></>}
      </section>
    </main><footer className="page-footer"><span>PRIVATE WORDS. VISIBLE CONNECTIONS.</span><span>BB84 protocol exploration · IBM Quantum integration</span></footer>
    {inviteOpen && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setInviteOpen(false); }}><section ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="invitation-title"><button className="icon-button modal-close" onClick={() => setInviteOpen(false)} aria-label="Close invitation"><X size={19}/></button><span className="modal-symbol"><Link2 size={25}/></span><span className="eyebrow">BETTER TOGETHER</span><h2 id="invitation-title">One link.<br/>A new connection.</h2><p>Share this single-use invitation with your conversation partner.</p><label>Invitation link<input readOnly value={inviteUrl} onFocus={e => e.target.select()}/></label><button className="primary-button modal-primary" onClick={() => void copyInvite()}>{copied ? <Check size={16}/> : <Copy size={16}/>}<span aria-live="polite">{copied ? "Invitation copied" : "Copy invitation link"}</span></button><p className="invite-note">The recipient also needs access to this site. Opening the link in another browser lets you try both sides.</p><button className="secondary-button modal-primary" onClick={() => setInviteOpen(false)}>Go to conversation<ArrowRight size={16}/></button><small>Keep this browser’s site data to retain access to your rooms.</small></section></div>}
  </div>;
}
