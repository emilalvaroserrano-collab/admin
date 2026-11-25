import { PhoneOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { askCsrAgent } from "@/lib/portal/mts-agent";
import { browserSpeak, elevenClip, geminiClip, playClip } from "@/lib/voice/csr-voice";

type Turn = { role: "user" | "assistant"; content: string };

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
  const host = window as Window & {
    SpeechRecognition?: new () => SpeechRec;
    webkitSpeechRecognition?: new () => SpeechRec;
  };
  const Ctor = host.SpeechRecognition || host.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export function openZendeskVoice() {
  window.dispatchEvent(new Event("mts-voice-start"));
}

export function ZendeskVoiceCall() {
  const [live, setLive] = useState(false);
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: 16 }, () => 0.12));
  const stopRef = useRef<(() => void) | null>(null);
  const openingRef = useRef(false);

  useEffect(() => {
    const onStart = () => {
      void start();
    };
    window.addEventListener("mts-voice-start", onStart);
    return () => window.removeEventListener("mts-voice-start", onStart);
  }, []);

  async function start() {
    if (stopRef.current || openingRef.current) return;
    openingRef.current = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      openingRef.current = false;
      return;
    }

    const audio = new Audio();
    audio.preload = "auto";
    const context = new AudioContext();
    if (context.state === "suspended") await context.resume();
    const analyser = context.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.75;
    const mic = context.createMediaStreamSource(stream);
    mic.connect(analyser);
    const playback = context.createMediaElementSource(audio);
    playback.connect(analyser);
    playback.connect(context.destination);

    let alive = true;
    let speaking = false;
    let heard = "";
    const history: Turn[] = [];
    const bins = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
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
      setLevels(
        quiet
          ? next.map((_, index) => 0.16 + Math.abs(Math.sin(Date.now() / 320 + index * 0.55)) * 0.22)
          : next,
      );
    };
    frame = requestAnimationFrame(paint);

    const recognizer = speechRecognizer();
    const listen = () => {
      if (!alive || speaking || !recognizer) return;
      heard = "";
      recognizer.onresult = (event) => {
        let finalText = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const row = event.results[index];
          if (row?.isFinal) finalText += row[0]?.transcript || "";
        }
        if (finalText.trim()) heard = finalText.trim();
      };
      recognizer.onerror = () => {};
      recognizer.onend = () => {
        const said = heard.trim();
        heard = "";
        if (!alive || speaking) return;
        if (said.length > 1) void reply(said);
        else listen();
      };
      try {
        recognizer.start();
      } catch {
        /* already listening */
      }
    };

    const say = async (text: string) => {
      const spoken = text.replace(/\s+/g, " ").trim();
      if (!spoken || !alive) return;
      speaking = true;
      try {
        recognizer?.abort();
      } catch {
        /* not listening */
      }
      try {
        let clip = await geminiClip(spoken, { history });
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
      } catch {
        /* keep the line open */
      }
      speaking = false;
      if (alive) listen();
    };

    const FILLERS = ["Mm-hmm.", "Okay, one sec.", "Hmm, let me see.", "Just a moment.", "Alright, give me a sec."];
    const reply = async (text: string) => {
      speaking = true;
      history.push({ role: "user", content: text });
      let answer = "";
      let failed = false;
      const answerPromise = askCsrAgent({ data: { text, history: history.slice(-8) } })
        .then((result) => { answer = result.answer?.trim() || "I could not complete that. Please say that again."; })
        .catch(() => { failed = true; });
      const wait = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); if (!alive) { clearTimeout(t); resolve(); } });
      await Promise.race([answerPromise, wait(1400)]);
      if (alive && !failed && !answer) {
        await say(FILLERS[Math.floor(Math.random() * FILLERS.length)]);
        if (!alive) return;
        await Promise.race([answerPromise, wait(4000)]);
        if (alive && !failed && !answer) await say(FILLERS[Math.floor(Math.random() * FILLERS.length)]);
      }
      await answerPromise;
      if (!alive) return;
      if (failed || !answer) answer = "I could not reach the agent. Please say that again.";
      history.push({ role: "assistant", content: answer });
      speaking = false;
      await say(answer);
    };



    const hangup = () => {
      if (!alive) return;
      alive = false;
      cancelAnimationFrame(frame);
      try {
        recognizer?.abort();
      } catch {
        /* already stopped */
      }
      audio.pause();
      window.speechSynthesis.cancel();
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
      stopRef.current = null;
      openingRef.current = false;
      setLive(false);
    };

    if (recognizer) {
      recognizer.continuous = false;
      recognizer.interimResults = true;
      recognizer.lang = "en-US";
    }
    stopRef.current = hangup;
    setLive(true);
    if (!recognizer) {
      await say("This browser cannot hear the call. Use Chrome, then try again.");
      hangup();
      return;
    }
    await say("Hi, this is the MTS agent. How can I help?");
  }

  function hangup() {
    stopRef.current?.();
  }

  if (!live) return null;
  return (
    <div
      className="fixed bottom-24 left-4 z-50 flex items-center gap-3 rounded-full bg-ink px-4 py-3 text-white shadow-[0_16px_40px_rgba(0,57,112,0.28)] md:bottom-8"
      role="status"
      aria-label="MTS Agent call"
    >
      <span className="flex h-8 w-40 items-center gap-1" aria-hidden="true">
        {levels.map((level, index) => (
          <span
            key={index}
            className="block w-full flex-1 rounded-full bg-accent"
            style={{ height: `${Math.max(4, Math.round(level * 32))}px` }}
          />
        ))}
      </span>
      <button type="button" className="grid size-9 place-items-center rounded-full bg-[#8e1f0b]" aria-label="End call" onClick={hangup}>
        <PhoneOff className="size-4" />
      </button>
    </div>
  );
}
