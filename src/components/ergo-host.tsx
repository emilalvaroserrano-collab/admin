import { useEffect } from "react";

type Job = {
  onChunk: (audio: ArrayBuffer) => void;
  onEnd: () => void;
  onError: (message: string) => void;
};

const jobs = new Map<number, Job>();
let frame: HTMLIFrameElement | null = null;
let nextId = 1;
let opened: Promise<void> | null = null;
let open: (() => void) | null = null;
let live = false;

function markOpen() {
  live = true;
  open?.();
}

function ready() {
  if (live) return Promise.resolve();
  opened ??= new Promise((resolve) => {
    open = () => {
      live = true;
      resolve();
    };
  });
  return opened;
}

export function startErgo(text: string, voice: string, job: Job) {
  const id = nextId;
  nextId += 1;
  jobs.set(id, job);
  void ready()
    .then(() => {
      const target = frame?.contentWindow;
      if (!target) throw new Error("Ergo is still starting.");
      target.postMessage({ type: "ergo-speak", id, text, voice }, location.origin);
    })
    .catch((cause) => {
      jobs.delete(id);
      job.onError(cause instanceof Error ? cause.message : "Ergo is still starting.");
    });
  return id;
}

export function ErgoHost() {
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || !event.data || typeof event.data !== "object") return;
      const data = event.data as { type?: string; id?: number; audio?: ArrayBuffer; error?: string };
      if (data.type === "ergo-ready") {
        markOpen();
        return;
      }
      if (typeof data.id !== "number") return;
      const job = jobs.get(data.id);
      if (!job) return;
      if (data.type === "ergo-pcm" && data.audio) job.onChunk(data.audio);
      if (data.type === "ergo-pcm-end") {
        jobs.delete(data.id);
        job.onEnd();
      }
      if (data.type === "ergo-error") {
        jobs.delete(data.id);
        job.onError(data.error || "Ergo could not read that.");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      ref={(node) => {
        frame = node;
      }}
      src="/ergo/frame.html"
      title="Ergo voice"
      aria-hidden="true"
      tabIndex={-1}
      onLoad={markOpen}
      className="pointer-events-none fixed bottom-0 left-0 h-px w-px opacity-0"
    />
  );
}
