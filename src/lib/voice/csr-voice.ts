import { getBearerToken } from "@/lib/auth/client";

/**
 * Client-side voice helpers for the CSR line.
 *
 * Order of preference for every spoken line:
 *   1. Gemini Live (`/api/agent/voice`) — the natural, human-sounding voice.
 *   2. ElevenLabs (`/api/agent/speak`) — only when its quota is healthy.
 *   3. The browser voice — last resort, never the default.
 */

export type SpokenClip = { url: string; revoke: () => void };

function authHeaders(): HeadersInit {
  const token = getBearerToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function toObjectUrl(base64: string, type: string): SpokenClip {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

/** Gemini Live first: it rephrases the verified answer in Sarah's own voice. */
export async function geminiClip(
  reply: string,
  options: { said?: string; history?: { role: "user" | "assistant"; content: string }[]; signal?: AbortSignal } = {},
): Promise<SpokenClip | null> {
  try {
    const response = await fetch("/api/agent/voice", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      signal: options.signal,
      body: JSON.stringify({
        reply: reply.slice(0, 1200),
        said: (options.said || "").slice(0, 400),
        history: (options.history || []).slice(-6),
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as { audio?: string; mime?: string };
    if (!response.ok || !payload.audio) return null;
    return toObjectUrl(payload.audio, payload.mime || "audio/wav");
  } catch {
    return null;
  }
}

/** ElevenLabs, when the account still has credits. */
export async function elevenClip(text: string): Promise<SpokenClip | null> {
  try {
    const response = await fetch("/api/agent/speak", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ text: text.slice(0, 700), provider: "elevenlabs" }),
    });
    const payload = (await response.json().catch(() => ({}))) as { audio?: string };
    if (!response.ok || !payload.audio) return null;
    return toObjectUrl(payload.audio, "audio/mpeg");
  } catch {
    return null;
  }
}

/** Natural-sounding browser voice, used only when both services are down. */
const PREFERRED_VOICES = [
  "Samantha",
  "Ava (Premium)",
  "Allison",
  "Serena",
  "Google US English",
  "Microsoft Aria Online (Natural) - English (United States)",
  "Microsoft Jenny Online (Natural) - English (United States)",
  "Karen",
  "Moira",
];

function pickBrowserVoice() {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  for (const name of PREFERRED_VOICES) {
    const found = voices.find((voice) => voice.name.toLowerCase().includes(name.toLowerCase()));
    if (found) return found;
  }
  return (
    voices.find((voice) => /^en[-_]US/i.test(voice.lang) && /female|samantha|ava|aria|jenny/i.test(voice.name)) ||
    voices.find((voice) => /^en[-_]US/i.test(voice.lang)) ||
    voices[0] ||
    null
  );
}

export function browserSpeak(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      resolve();
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickBrowserVoice();
    if (voice) utter.voice = voice;
    utter.rate = 1.02;
    utter.pitch = 1;
    utter.volume = 1;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    utter.onend = done;
    utter.onerror = done;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
    // Some browsers never fire onend for cancelled utterances.
    setTimeout(done, Math.min(20_000, 1200 + text.length * 90));
  });
}

/** Play a clip to completion, resolving when the line goes quiet again. */
export function playClip(audio: HTMLAudioElement, clip: SpokenClip): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clip.revoke();
      audio.onended = null;
      audio.onerror = null;
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.src = clip.url;
    void audio.play().catch(done);
  });
}
