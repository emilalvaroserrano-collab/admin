import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, MessageSquare, Mic, MicOff, Phone, PhoneOff, Send, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { startCsrCall, type CsrCallHandle, type CsrState, type CsrTurn } from "@/lib/voice/csr-call";

const IDLE_LEVELS = Array.from({ length: 24 }, (_, index) => 0.08 + (index % 5) * 0.015);

const STATUS: Record<CsrState, string> = {
  connecting: "Connecting…",
  listening: "Listening — go ahead",
  thinking: "Checking our system…",
  speaking: "Sarah is speaking",
  ended: "Call ended",
};

const STATUS_TONE: Record<CsrState, string> = {
  connecting: "text-[#f7d892]",
  listening: "text-[#8fe6d0]",
  thinking: "text-[#f7d892]",
  speaking: "text-[#f5d49a]",
  ended: "text-[#9bacc1]",
};

export function CsrCall() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<"idle" | "live" | "ended">("idle");
  const [state, setState] = useState<CsrState>("connecting");
  const [levels, setLevels] = useState<number[]>(IDLE_LEVELS);
  const [turns, setTurns] = useState<CsrTurn[]>([]);
  const [heard, setHeard] = useState("");
  const [notice, setNotice] = useState("");
  const [muted, setMuted] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const handleRef = useRef<CsrCallHandle | null>(null);
  const transcript = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      handleRef.current?.hangup();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    const box = transcript.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns, heard]);

  async function start() {
    if (starting || handleRef.current) return;
    setStarting(true);
    setPhase("live");
    setTurns([]);
    setHeard("");
    setNotice("");
    setState("connecting");
    const handle = await startCsrCall({
      onState: setState,
      onLevels: setLevels,
      onTurn: (turn) => setTurns((prev) => [...prev.slice(-8), turn]),
      onHeard: setHeard,
      onNotice: (message) => {
        setNotice(message);
        setTextMode(true);
      },
    });
    handleRef.current = handle;
    setStarting(false);
    if (!handle.micReady) setTextMode(true);
  }

  function hangup() {
    handleRef.current?.hangup();
    handleRef.current = null;
    setPhase("ended");
  }

  function sendText() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (!handleRef.current) {
      void start().then(() => handleRef.current?.send(text));
      return;
    }
    handleRef.current.send(text);
  }

  const speaking = state === "speaking";
  const listening = state === "listening";

  return (
    <div className="relative flex min-h-dvh w-full flex-col overflow-hidden bg-[#050c16] text-[#eef3f9]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60rem 34rem at 50% -12%, rgba(23,86,140,0.55), transparent 62%), radial-gradient(38rem 26rem at 110% 8%, rgba(18,126,134,0.28), transparent 60%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-64"
        style={{ background: "linear-gradient(to top, rgba(3,8,14,0.92), transparent)" }}
      />

      <header className="relative z-10 mx-auto flex w-full max-w-lg items-center justify-between gap-3 px-5 pt-6">
        <button
          type="button"
          onClick={() => navigate({ to: "/portal" })}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-[#c6d3e2] transition hover:bg-white/10"
        >
          <ArrowLeft className="size-4" />
          Portal
        </button>
        <div className="text-right">
          <p className="text-[10px] font-bold uppercase tracking-[1.8px] text-[#7e91a8]">Manage Tech Service</p>
          <p className="text-sm font-semibold text-[#e8eef6]">Customer Care line</p>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-lg flex-1 flex-col px-5 pb-8 pt-8">
        <div className="flex flex-col items-center text-center">
          <div className="relative grid place-items-center">
            <span
              aria-hidden="true"
              className={`absolute size-44 rounded-full border border-[#d8ad54]/25 ${speaking ? "animate-ping" : ""}`}
              style={{ animationDuration: "2.4s" }}
            />
            <span aria-hidden="true" className="absolute size-52 rounded-full border border-dashed border-[#8c7543]/30" />
            <div
              className={`relative grid size-36 place-items-center rounded-full border-4 border-[#1d2c40] shadow-[0_24px_60px_rgba(0,0,0,0.55)] transition ${
                speaking ? "scale-[1.03]" : ""
              }`}
              style={{ background: "radial-gradient(circle at 36% 26%, #4a5f7a, #22344c 46%, #121e2d 78%)" }}
            >
              <span className="text-5xl font-bold tracking-[-3px] text-[#f5d49a]">S</span>
              <span
                className={`absolute -bottom-1 right-1 size-6 rounded-full border-4 border-[#0a1421] ${
                  listening ? "bg-[#52d8a5]" : speaking ? "bg-[#eac476]" : state === "thinking" ? "bg-[#f7d892]" : "bg-[#5b6b7e]"
                }`}
              />
            </div>
          </div>

          <h1 className="mt-6 text-2xl font-semibold tracking-[-0.5px]">Sarah</h1>
          <p className="mt-1 text-sm text-[#9bacc1]">Customer Support · Los Angeles</p>

          <div className="mt-4 flex min-h-7 items-center gap-2" aria-live="polite">
            <span className={`size-1.5 rounded-full ${listening ? "bg-[#52d8a5]" : speaking ? "bg-[#eac476]" : "bg-[#8a9bb0]"}`} />
            <p className={`text-sm font-semibold ${STATUS_TONE[state]}`}>{phase === "ended" ? STATUS.ended : STATUS[state]}</p>
          </div>

          <div className="mt-4 flex h-12 w-full max-w-xs items-center justify-center gap-[3px]" aria-hidden="true">
            {levels.map((level, index) => (
              <span
                key={index}
                className="block w-full max-w-[5px] flex-1 rounded-full transition-[height] duration-75"
                style={{
                  height: `${Math.max(4, Math.round(level * 46))}px`,
                  background: speaking
                    ? "linear-gradient(#ffe8b9, #d5a75a)"
                    : listening
                      ? "linear-gradient(#a9f3d9, #3aa88a)"
                      : "linear-gradient(#9fb2c7, #5b6b7e)",
                  opacity: speaking || listening ? 0.95 : 0.45,
                }}
              />
            ))}
          </div>

          {heard && listening ? (
            <p className="mt-1 max-w-sm truncate text-xs italic text-[#9bacc1]">“{heard}”</p>
          ) : null}
        </div>

        {notice ? (
          <p className="mx-auto mt-3 max-w-sm rounded-lg border border-[#6b573b] bg-[#392f23]/80 px-3 py-2 text-center text-xs text-[#f7d892]">
            {notice}
          </p>
        ) : null}

        <div
          ref={transcript}
          className="mt-5 max-h-56 flex-1 space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.035] p-4 text-left backdrop-blur"
        >
          {turns.length === 0 ? (
            <p className="py-6 text-center text-xs text-[#7d8fa1]">
              {phase === "idle"
                ? "Start the call and ask about an order, a repair, or your account."
                : "The conversation will appear here."}
            </p>
          ) : (
            turns.map((turn, index) => (
              <div key={`${turn.role}-${index}`} className={turn.role === "user" ? "text-right" : ""}>
                <p className="text-[10px] font-bold uppercase tracking-[0.8px] text-[#8ea0b3]">
                  {turn.role === "assistant" ? "Sarah" : "You"}
                </p>
                <p
                  className={`mt-1 inline-block max-w-[92%] rounded-xl px-3 py-2 text-[13px] leading-relaxed ${
                    turn.role === "assistant" ? "bg-white/[0.07] text-[#dbe5ef]" : "bg-[#eac476]/15 text-[#f7e3b8]"
                  }`}
                >
                  {turn.content}
                </p>
              </div>
            ))
          )}
        </div>

        {phase === "idle" ? (
          <div className="mt-6 space-y-3">
            <button
              type="button"
              onClick={() => void start()}
              disabled={starting}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#e7bf73] to-[#f5d899] text-sm font-extrabold text-[#18212b] shadow-[0_18px_40px_rgba(234,196,118,0.22)] transition hover:brightness-105 disabled:opacity-60"
            >
              <Phone className="size-4" />
              Call Sarah
            </button>
            <p className="text-center text-[11px] text-[#7d8fa1]">
              Live voice over Gemini · no app install needed
            </p>
          </div>
        ) : phase === "ended" ? (
          <div className="mt-6 space-y-3">
            <button
              type="button"
              onClick={() => {
                setPhase("idle");
                setTurns([]);
                setNotice("");
                setMuted(false);
                setTextMode(false);
              }}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#e7bf73] to-[#f5d899] text-sm font-extrabold text-[#18212b]"
            >
              <Phone className="size-4" />
              Call again
            </button>
            <button
              type="button"
              onClick={() => navigate({ to: "/portal" })}
              className="flex h-11 w-full items-center justify-center rounded-xl border border-white/10 bg-white/5 text-sm font-semibold text-[#c6d3e2]"
            >
              Back to portal
            </button>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <div className="flex items-center justify-center gap-8">
              <div className="grid justify-items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const next = !muted;
                    setMuted(next);
                    handleRef.current?.setMuted(next);
                  }}
                  aria-pressed={muted}
                  aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                  className={`grid size-14 place-items-center rounded-full border transition ${
                    muted ? "border-[#e68192] bg-[#573441] text-[#ffc2ca]" : "border-[#324355] bg-[#202d3d] text-[#e3ebf3] hover:bg-[#26374a]"
                  }`}
                >
                  {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
                </button>
                <span className="text-[11px] text-[#9dabbe]">{muted ? "Muted" : "Mute"}</span>
              </div>

              <div className="grid justify-items-center gap-2">
                <button
                  type="button"
                  onClick={hangup}
                  aria-label="End call"
                  className="grid size-16 place-items-center rounded-full bg-gradient-to-br from-[#d95767] to-[#f07982] text-white shadow-[0_16px_34px_rgba(217,87,103,0.3)] transition hover:brightness-105"
                >
                  <PhoneOff className="size-6" />
                </button>
                <span className="text-[11px] text-[#9dabbe]">End call</span>
              </div>

              <div className="grid justify-items-center gap-2">
                <button
                  type="button"
                  onClick={() => setTextMode((open) => !open)}
                  aria-pressed={textMode}
                  aria-label="Type instead of talking"
                  className={`grid size-14 place-items-center rounded-full border transition ${
                    textMode ? "border-[#8c7543] bg-[#3a3223] text-[#f7d892]" : "border-[#324355] bg-[#202d3d] text-[#e3ebf3] hover:bg-[#26374a]"
                  }`}
                >
                  <MessageSquare className="size-5" />
                </button>
                <span className="text-[11px] text-[#9dabbe]">Type</span>
              </div>
            </div>

            {textMode ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  sendText();
                }}
                className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] p-2"
              >
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Type your question for Sarah…"
                  aria-label="Type your question"
                  className="min-w-0 flex-1 bg-transparent px-2 text-sm text-[#eef3f9] outline-none placeholder:text-[#7d8fa1]"
                />
                <button
                  type="submit"
                  aria-label="Send message"
                  className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#e7bf73] to-[#f5d899] text-[#18212b]"
                >
                  <Send className="size-4" />
                </button>
              </form>
            ) : null}

            <p className="flex items-center justify-center gap-1.5 text-[11px] text-[#6f8095]">
              <ShieldCheck className="size-3.5" />
              This call is handled by our own support system
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
