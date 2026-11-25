import { useMutation } from "@tanstack/react-query";
import { Loader2, MessageCircle, Phone, Send, X } from "lucide-react";
import { useState } from "react";
import { openZendeskVoice } from "@/components/zendesk-voice-call";
import { askZendeskWidget } from "@/lib/portal/mts-agent";

type Turn = { role: "user" | "assistant"; content: string };

export function ZendeskAgentWidget({ mode = "float", call = false }: { mode?: "float" | "embedded"; call?: boolean }) {
  const [open, setOpen] = useState(mode === "embedded");
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const ask = useMutation({
    mutationFn: (input: { text: string; history: Turn[] }) => askZendeskWidget({ data: input }),
    onSuccess: (result) => {
      setTurns((current) => [...current, { role: "assistant", content: result.answer }]);
      setError("");
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "The Zendesk AI agent did not reply."),
  });

  function send() {
    const text = draft.trim();
    if (!text || ask.isPending) return;
    const history = [...turns, { role: "user" as const, content: text }];
    setDraft("");
    setTurns(history);
    ask.mutate({ text, history });
  }

  const panel = (
    <section className={mode === "embedded" ? "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-white" : "grid h-[min(34rem,calc(100dvh-8rem))] w-[min(24rem,calc(100vw-2rem))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-3xl border border-line bg-white shadow-[0_24px_60px_rgba(0,57,112,0.18)]"}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">MTS Agent</p>
          <p className="truncate text-xs text-muted">The agent on the Manage Tech Services widget</p>
        </div>
        {call || mode === "float" ? (
          <div className="flex shrink-0 items-center gap-1">
            {call ? (
              <button
                type="button"
                className="grid size-8 place-items-center rounded-full bg-ink text-white"
                aria-label="Call MTS Agent"
                onClick={() => openZendeskVoice()}
              >
                <Phone className="size-4" />
              </button>
            ) : null}
            {mode === "float" ? (
              <button type="button" className="grid size-8 place-items-center rounded-full hover:bg-surface-2" aria-label="Close MTS Agent" onClick={() => setOpen(false)}>
                <X className="size-4" />
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      <div className="min-h-0 overflow-y-auto px-4 py-4">
        {turns.length === 0 ? (
          <p className="pt-8 text-center text-sm leading-6 text-muted">Ask about support, orders, or services. MTS Agent can handle it from here.</p>
        ) : (
          <div className="grid gap-3">
            {turns.map((turn, index) => (
              <p key={`${turn.role}-${index}`} className={turn.role === "user" ? "ml-auto max-w-[85%] rounded-2xl bg-ink px-3 py-2 text-sm text-white" : "max-w-[90%] text-sm leading-6 text-ink"}>
                {turn.content}
              </p>
            ))}
            {ask.isPending ? <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> The agent is replying</p> : null}
          </div>
        )}
      </div>
      <form
        className="border-t border-line p-3"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {error ? <p className="mb-2 text-xs text-bad">{error}</p> : null}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            rows={1}
            placeholder="Message MTS Agent"
            className="max-h-28 min-h-10 flex-1 resize-none rounded-2xl border border-line px-3 py-2 text-sm outline-none"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <button type="submit" disabled={ask.isPending || !draft.trim()} className="grid size-10 shrink-0 place-items-center rounded-full bg-ink text-white disabled:opacity-40" aria-label="Send">
            <Send className="size-4" />
          </button>
        </div>
      </form>
    </section>
  );

  if (mode === "embedded") return panel;
  return (
    <div className="fixed bottom-24 right-4 z-40 md:bottom-6">
      {open ? <div className="mb-3">{panel}</div> : null}
      <button type="button" className="ml-auto flex items-center gap-2 rounded-full bg-ink px-4 py-3 text-sm font-semibold text-white shadow-lg" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <MessageCircle className="size-4" />
        MTS Agent
      </button>
    </div>
  );
}
