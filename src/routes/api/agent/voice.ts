import { createFileRoute } from "@tanstack/react-router";
import { GoogleGenAI, Modality } from "@google/genai";
import { assertSameSiteRequest } from "@/lib/auth/isolation.server";
import { requireUserId } from "@/lib/auth/verify.server";

/**
 * Gemini Live voice for the CSR line.
 *
 * The Zendesk brain decides *what* is true; Gemini Live decides *how it sounds*.
 * We open a short Live session, hand it the verified answer plus the customer's
 * last words, and collect the native audio (24 kHz PCM) it speaks back. No
 * WebRTC, no Vapi, no browser speechSynthesis — this is the natural voice.
 *
 * Auth: cookie session or the preview bearer token, same contract as
 * `/api/agent/speak`.
 */

const DEFAULT_MODEL = "gemini-3.8-live";
const DEFAULT_VOICE = "Zephyr";
const MAX_TEXT = 1200;

type Turn = { role: "user" | "assistant"; content: string };

function liveClient() {
  const backend = (process.env.GEMINI_LIVE_BACKEND || "").trim().toLowerCase();
  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY || "").trim();
  // The Developer API only exposes the Live socket on v1alpha.
  if (backend !== "vertex" && apiKey) {
    return new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
  }
  return new GoogleGenAI({
    vertexai: true,
    project: (process.env.GOOGLE_CLOUD_PROJECT || "beatrice-os").trim(),
    location: (process.env.GOOGLE_CLOUD_LOCATION || "us-central1").trim(),
  });
}

function persona() {
  return [
    "You are Sarah, the customer service voice for Manage Tech Service (MTS) in Los Angeles.",
    "You are on a phone call with a customer. Speak like a calm, warm human receptionist — natural pacing, small breaths, contractions.",
    "Say the verified answer you are given. Do not add facts, prices, dates, or promises that are not in it.",
    "Keep it to one to three short spoken sentences. No lists, no markdown, no emoji, no stage directions, never say you are an AI or a model.",
    "Never read a URL out loud: say 'our website' instead.",
    "If the verified answer says someone will follow up, say that kindly and briefly.",
    "The caller's own words are provided for tone only. Answer in first person plural for the company: we, us, our.",
  ].join(" ");
}

function speechPrompt(said: string, reply: string, history: Turn[]) {
  const recent = history
    .slice(-4)
    .map((turn) => `${turn.role === "user" ? "Customer" : "You"}: ${turn.content}`)
    .join("\n");
  return [
    recent ? `Recent conversation:\n${recent}` : "",
    said ? `Customer just said: "${said}"` : "",
    `Verified answer from our system: "${reply}"`,
    "Now say the answer out loud as Sarah.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

type WavOptions = { sampleRate: number; channels: number; bitsPerSample: number };

function parseAudioMime(mime: string): WavOptions {
  const options: WavOptions = { sampleRate: 24000, channels: 1, bitsPerSample: 16 };
  const [fileType, ...params] = mime.split(";").map((part) => part.trim());
  const format = fileType.split("/")[1] || "";
  if (/^l\d+$/i.test(format)) options.bitsPerSample = Number(format.slice(1)) || 16;
  for (const param of params) {
    const [key, value] = param.split("=").map((part) => part.trim());
    if (key === "rate") options.sampleRate = Number(value) || options.sampleRate;
    if (key === "channels") options.channels = Number(value) || options.channels;
  }
  return options;
}

function wavHeader(dataLength: number, options: WavOptions) {
  const { sampleRate, channels, bitsPerSample } = options;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function toWav(chunks: Buffer[], mime: string) {
  const data = Buffer.concat(chunks);
  const header = wavHeader(data.length, parseAudioMime(mime));
  return Buffer.concat([header, data]);
}

async function speakWithLive(reply: string, said: string, history: Turn[], voice: string) {
  const ai = liveClient();
  const chunks: Buffer[] = [];
  let mime = "";
  let transcript = "";
  let settled = false;

  const turn = new Promise<void>((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    ai.live
      .connect({
        model: (process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL).trim(),
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: persona() }] },
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onmessage: (message) => {
            const content = message.serverContent;
            for (const part of content?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                chunks.push(Buffer.from(part.inlineData.data, "base64"));
                mime ||= part.inlineData.mimeType || "";
              }
              if (part.text) transcript += part.text;
            }
            if (content?.outputTranscription?.text) transcript += content.outputTranscription.text;
            if (content?.turnComplete) finish();
          },
          onerror: () => finish(),
          onclose: () => finish(),
        },
      })
      .then((session) => {
        session.sendClientContent({
          turns: [{ role: "user", parts: [{ text: speechPrompt(said, reply, history) }] }],
          turnComplete: true,
        });
        // The Live socket can go quiet on a bad network; never hang the caller.
        setTimeout(() => {
          finish();
          try {
            session.close();
          } catch {
            /* already closed */
          }
        }, 20_000);
      })
      .catch(() => finish());
  });

  await turn;
  return { chunks, mime, transcript };
}

export const Route = createFileRoute("/api/agent/voice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          assertSameSiteRequest();
        } catch {
          return Response.json({ error: "Forbidden." }, { status: 403 });
        }

        const header = request.headers.get("authorization") || "";
        const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
        try {
          await requireUserId(bearer);
        } catch {
          return Response.json({ error: "Sign in first." }, { status: 401 });
        }

        const raw = (await request.json().catch(() => ({}))) as {
          reply?: string;
          said?: string;
          voice?: string;
          history?: unknown;
        };

        const reply = typeof raw.reply === "string" ? raw.reply.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "";
        if (!reply) return Response.json({ error: "Nothing to say." }, { status: 400 });

        const said = typeof raw.said === "string" ? raw.said.replace(/\s+/g, " ").trim().slice(0, 400) : "";
        const voice = typeof raw.voice === "string" && raw.voice.trim() ? raw.voice.trim() : DEFAULT_VOICE;
        const history: Turn[] = Array.isArray(raw.history)
          ? raw.history.slice(-6).flatMap((item) => {
              const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
              const content = typeof row.content === "string" ? row.content.trim().slice(0, 400) : "";
              if (!content) return [];
              return [{ role: row.role === "assistant" ? ("assistant" as const) : ("user" as const), content }];
            })
          : [];

        const started = Date.now();
        try {
          const { chunks, mime, transcript } = await speakWithLive(reply, said, history, voice);
          if (!chunks.length) {
            return Response.json({ error: "The voice did not answer.", fallback: true }, { status: 502 });
          }
          const wav = toWav(chunks, mime);
          return Response.json({
            audio: wav.toString("base64"),
            mime: "audio/wav",
            text: transcript.trim() || reply,
            ms: Date.now() - started,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "The voice is unavailable.";
          return Response.json({ error: message, fallback: true }, { status: 502 });
        }
      },
    },
  },
});
