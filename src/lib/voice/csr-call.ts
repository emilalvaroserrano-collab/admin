import { askZendeskWidget } from "@/lib/portal/mts-agent";
import { browserSpeak, elevenClip, geminiClip, playClip } from "./csr-voice";

/**
 * The CSR call engine — no WebRTC, no Vapi.
 *
 * Mic → browser speech recognition → Zendesk brain (`askZendeskWidget`) →
 * Gemini Live native audio. The same engine powers the full-page call screen
 * and the floating portal widget.
 */

export type CsrState = "connecting" | "listening" | "thinking" | "speaking" | "ended";
export type CsrTurn = { role: "user" | "assistant"; content: string };

export type CsrCallOptions = {
  greeting?: string;
  onState?: (state: CsrState) => void;
  onLevels?: (levels: number[]) => void;
  onTurn?: (turn: CsrTurn) => void;
  onHeard?: (text: string) => void;
  onNotice?: (message: string) => void;
};

export type CsrCallHandle = {
  hangup: () => void;
  send: (text: string) => void;
  setMuted: (muted: boolean) => void;
  isMuted: () => boolean;
  micReady: boolean;
};

type SpeechRec = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

function speechRecognizer() {
  if (typeof window === "undefined") return null;
  const host = window as Window & {
    SpeechRecognition?: new () => SpeechRec;
    webkitSpeechRecognition?: new () => SpeechRec;
  };
  const Ctor = host.SpeechRecognition || host.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

const GREETING = "Hi, this is Sarah with Manage Tech Service. How can I help you today?";
const TROUBLE = "I'm having trouble reaching our system. Give me one moment and ask me again.";
const SILENCE = [0.08, 0.12, 0.1, 0.14, 0.09, 0.13, 0.11, 0.15, 0.1, 0.12, 0.14, 0.09, 0.13, 0.11, 0.15, 0.1];

export async function startCsrCall(options: CsrCallOptions = {}): Promise<CsrCallHandle> {
  const emitState = options.onState || (() => {});
  const emitLevels = options.onLevels || (() => {});
  const emitTurn = options.onTurn || (() => {});
  const emitHeard = options.onHeard || (() => {});
  const notice = options.onNotice || (() => {});

  let alive = true;
  let muted = false;
  let state: CsrState = "connecting";
  let heard = "";
  let frame = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  const history: CsrTurn[] = [];

  const audio = new Audio();
  audio.preload = "auto";

  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    notice("No microphone access. You can still type to Sarah below.");
  }

  const context = new AudioContext();
  if (context.state === "suspended") await context.resume();
  const analyser = context.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.75;
  if (stream) context.createMediaStreamSource(stream).connect(analyser);
  const playback = context.createMediaElementSource(audio);
  playback.connect(analyser);
  playback.connect(context.destination);

  const bins = new Uint8Array(analyser.frequencyBinCount);
  const paint = () => {
    if (!alive) return;
    frame = requestAnimationFrame(paint);
    analyser.getByteFrequencyData(bins);
    const next = Array.from({ length: 16 }, (_, index) => {
      const startAt = Math.floor((index / 16) * bins.length);
      const endAt = Math.max(startAt + 1, Math.floor(((index + 1) / 16) * bins.length));
      let sum = 0;
      for (let bin = startAt; bin < endAt; bin += 1) sum += bins[bin] || 0;
      return sum / (endAt - startAt) / 255;
    });
    const quiet = next.every((level) => level < 0.04);
    emitLevels(
      quiet
        ? SILENCE.map((base, index) => base + Math.abs(Math.sin(Date.now() / 320 + index * 0.55)) * 0.2)
        : next,
    );
  };
  frame = requestAnimationFrame(paint);

  const setState = (next: CsrState) => {
    state = next;
    emitState(next);
  };

  const recognizer = stream ? speechRecognizer() : null;
  if (recognizer) {
    recognizer.continuous = false;
    recognizer.interimResults = true;
    recognizer.lang = "en-US";
  }

  const listen = () => {
    if (!alive || !recognizer || state !== "listening") return;
    heard = "";
    recognizer.onresult = (event) => {
      let finalText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const row = event.results[index];
        if (row?.isFinal) finalText += row[0]?.transcript || "";
        else if (row?.[0]?.transcript) emitHeard(row[0].transcript);
      }
      if (finalText.trim()) heard = finalText.trim();
    };
    recognizer.onerror = () => {};
    recognizer.onend = () => {
      const said = heard.trim();
      heard = "";
      if (!alive || state !== "listening") return;
      if (said.length > 1) void reply(said);
      else if (restartTimer === null) restartTimer = setTimeout(() => { restartTimer = null; listen(); }, 350);
    };
    try {
      recognizer.start();
    } catch {
      /* already listening */
    }
  };

  const stopListening = () => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    try {
      recognizer?.abort();
    } catch {
      /* not listening */
    }
  };

  const speak = async (text: string, said = "") => {
    const spoken = text.replace(/\s+/g, " ").trim();
    if (!spoken || !alive) return;
    stopListening();
    setState("speaking");
    let clip = await geminiClip(spoken, { said, history });
    if (!alive) {
      clip?.revoke();
      return;
    }
    if (!clip) clip = await elevenClip(spoken);
    if (!alive) {
      clip?.revoke();
      return;
    }
    if (clip) await playClip(audio, clip);
    else await browserSpeak(spoken);
    if (!alive) return;
    setState("listening");
    listen();
  };

  const reply = async (text: string) => {
    const said = text.trim();
    if (!said || !alive) return;
    stopListening();
    setState("thinking");
    emitTurn({ role: "user", content: said });
    history.push({ role: "user", content: said });
    let answer = "";
    try {
      const result = await askZendeskWidget({ data: { text: said, history: history.slice(-8) } });
      answer = (result.answer || "").trim();
    } catch {
      answer = "";
    }
    if (!alive) return;
    if (!answer) answer = TROUBLE;
    emitTurn({ role: "assistant", content: answer });
    history.push({ role: "assistant", content: answer });
    await speak(answer, said);
  };

  const hangup = () => {
    if (!alive) return;
    alive = false;
    cancelAnimationFrame(frame);
    stopListening();
    audio.pause();
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    stream?.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => {});
    setState("ended");
  };

  setState("connecting");
  void speak(options.greeting || GREETING);

  return {
    hangup,
    send: (text: string) => void reply(text),
    setMuted: (next: boolean) => {
      muted = next;
      stream?.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      if (next) stopListening();
      else if (alive && state === "listening") listen();
    },
    isMuted: () => muted,
    micReady: Boolean(stream && recognizer),
  };
}
