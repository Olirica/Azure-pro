import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

// In-memory session state
let browser = null;
let speakerContext = null;
let listenerContext = null;
let speakerPage = null;
let listenerPage = null;

function now() {
  return Date.now();
}

const RunSessionSchema = z.object({
  serverUrl: z.string().default("http://localhost:3000"),
  roomId: z.string().default("mcp-room"),
  sourceLang: z.string().default("en-CA"),
  targetLang: z.string().default("fr-CA"),
  audioFile: z.string(),
  timeoutMs: z.number().int().positive().default(120000),
  headed: z.boolean().default(false),
  // Audio shaping
  targetSampleRate: z.number().int().positive().default(16000),
  mono: z.boolean().default(true),
  normalize: z.boolean().default(false),
  targetPeak: z.number().min(0.1).max(1).default(0.9),
  startAtSec: z.number().nonnegative().default(0),
  durationSec: z.number().positive().optional(),
  playbackRate: z.number().positive().default(1.0),
  transferMode: z.enum(["base64", "route"]).default("route"),
  selectors: z
    .object({
      startButton: z.string().default("#startBtn"),
      connectButton: z.string().default("#connectBtn"),
      roomInput: z.string().default("#roomId"),
      sourceLangInput: z.string().default("#sourceLang"),
      targetLangsInput: z.string().default("#targetLangs"),
      singleTargetSelect: z.string().default("#targetLang"),
      ttsToggle: z.string().default("#ttsToggle"),
      speakerListeningStatus: z.string().default("#recognitionStatus"),
      listenerConnectionStatus: z.string().default("#connectionStatus"),
    })
    .partial()
    .default({}),
});

// Merge provided selector overrides with defaults
function mergedSelectors(overrides = {}) {
  return {
    // Prefer text-based selectors to match SPA
    startButton: 'button:has-text("Start")',
    connectButton: 'button:has-text("Connect")',
    // Not used for SPA; room is passed via URL
    roomInput: '',
    sourceLangInput: '',
    targetLangsInput: '',
    singleTargetSelect: '',
    // First checkbox is TTS toggle in both layouts
    ttsToggle: 'input[type="checkbox"]',
    speakerListeningStatus: '#recognitionStatus',
    listenerConnectionStatus: '#connectionStatus',
    ...overrides,
  };
}

async function ensureClosed() {
  try {
    if (speakerPage) await speakerPage.close({ runBeforeUnload: true });
  } catch {}
  try {
    if (listenerPage) await listenerPage.close({ runBeforeUnload: true });
  } catch {}
  try {
    if (speakerContext) await speakerContext.close();
  } catch {}
  try {
    if (listenerContext) await listenerContext.close();
  } catch {}
  try {
    if (browser) await browser.close();
  } catch {}
  browser = null;
  speakerContext = null;
  listenerContext = null;
  speakerPage = null;
  listenerPage = null;
}

async function runFakeMicSession(input, server) {
  const {
    serverUrl,
    roomId,
    sourceLang,
    targetLang,
    audioFile,
    timeoutMs,
    headed,
    targetSampleRate,
    mono,
    normalize,
    targetPeak,
    startAtSec,
    durationSec,
    playbackRate,
    selectors: selectorOverrides,
  } = RunSessionSchema.parse(input);

  const sel = mergedSelectors(selectorOverrides);

  function langNameFromCode(code) {
    const m = String(code || '').toLowerCase();
    if (m === 'fr-ca') return 'French (Canada)';
    if (m === 'fr-fr') return 'French (France)';
    if (m === 'en-us') return 'English (United States)';
    if (m === 'en-ca') return 'English (Canada)';
    if (m === 'es-es') return 'Spanish (Spain)';
    if (m === 'es-mx') return 'Spanish (Mexico)';
    return code;
  }

  // Validate audio file exists
  const audioPath = path.resolve(process.cwd(), audioFile);
  const audioBuffer = await fs.readFile(audioPath);
  const audioBase64 = audioBuffer.toString("base64");

  // Metrics container
  const metrics = {
    startedAt: now(),
    speakerEvents: [],
    listenerEvents: [],
    fastFinals: [],
    ttsQueue: [],
    translations: [],
    errors: [],
    summary: {},
  };

  // Launch browser
  browser = await chromium.launch({ headless: !headed });

  // Create contexts (grant microphone for speaker)
  speakerContext = await browser.newContext({ permissions: ["microphone"], bypassCSP: true });
  listenerContext = await browser.newContext({ permissions: [], bypassCSP: true });

  // Inject fake microphone using WebAudio pipeline before any page scripts
  // If using route mode, mount a virtual endpoint for the page to fetch the audio bytes
  if (input.transferMode === "route") {
    await speakerContext.route("**/__mcp__/audio", async (route) => {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: audioBuffer });
    });
  }

  await speakerContext.addInitScript(({ audioData, cfg }) => {
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      if (constraints && constraints.audio) {
        console.log("[FakeMic] Creating fake audio stream from injected data...");
        const BaseAudioContext = window.AudioContext || window.webkitAudioContext;
        const audioContext = new BaseAudioContext();
        let arrayBuf;
        if (cfg.audioUrl) {
          const resp = await fetch(cfg.audioUrl);
          arrayBuf = await resp.arrayBuffer();
        } else {
          arrayBuf = Uint8Array.from(atob(audioData), (c) => c.charCodeAt(0)).buffer;
        }
        let decoded = await audioContext.decodeAudioData(arrayBuf);
        console.log(`[FakeMic] Decoded duration=${decoded.duration.toFixed(2)}s SR=${decoded.sampleRate}Hz channels=${decoded.numberOfChannels}`);

        // Resample + downmix if needed using OfflineAudioContext
        const needResample = decoded.sampleRate !== cfg.targetSampleRate || (cfg.mono && decoded.numberOfChannels !== 1);
        if (needResample) {
          const length = Math.ceil(decoded.duration * cfg.targetSampleRate);
          const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
          const offline = new Offline(cfg.mono ? 1 : decoded.numberOfChannels, length, cfg.targetSampleRate);
          const src = offline.createBufferSource();
          src.buffer = decoded;
          src.connect(offline.destination);
          src.start(0);
          decoded = await offline.startRendering();
          console.log(`[FakeMic] Resampled to SR=${decoded.sampleRate}Hz channels=${decoded.numberOfChannels}`);
        }

        // Optional peak normalization
        if (cfg.normalize) {
          let peak = 0;
          for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
            const data = decoded.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
              const v = Math.abs(data[i]);
              if (v > peak) peak = v;
            }
          }
          if (peak > 0 && cfg.targetPeak > 0) {
            const gain = Math.min(cfg.targetPeak / peak, 8);
            for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
              const data = decoded.getChannelData(ch);
              for (let i = 0; i < data.length; i++) data[i] *= gain;
            }
            console.log(`[FakeMic] Normalized with gain=${gain.toFixed(2)} targetPeak=${cfg.targetPeak}`);
          }
        }

        // Use an AudioContext configured to the target sample rate to avoid extra SRC on output
        const outCtx = new BaseAudioContext();
        const destination = outCtx.createMediaStreamDestination();
        const source = outCtx.createBufferSource();
        source.buffer = decoded;
        if (typeof cfg.playbackRate === 'number' && isFinite(cfg.playbackRate)) {
          try { source.playbackRate.value = cfg.playbackRate; } catch {}
        }
        source.connect(destination);
        // Trim/offset if configured
        if (cfg.durationSec) source.start(0, cfg.startAtSec, cfg.durationSec);
        else source.start(0, cfg.startAtSec || 0);
        console.log(`[FakeMic] Playback started at SR=${outCtx.sampleRate}Hz from ${cfg.startAtSec || 0}s` + (cfg.durationSec ? ` for ${cfg.durationSec}s` : "") + ` rate=${cfg.playbackRate ?? 1}`);
        return destination.stream;
      }
      return realGetUserMedia(constraints);
    };
  }, { audioData: audioBase64, cfg: { targetSampleRate, mono, normalize, targetPeak, startAtSec, durationSec, playbackRate, audioUrl: (input.transferMode === 'route' ? '/__mcp__/audio' : undefined) } });

  // Create pages
  speakerPage = await speakerContext.newPage();
  listenerPage = await listenerContext.newPage();

  // Hook console logs to capture events and progress
  speakerPage.on("console", (msg) => {
    const text = msg.text();
    const timestamp = now();
    try {
      if (text.includes("FAST-FINAL") || text.includes("FAST-FINALS")) {
        const match = text.match(/segment\":\"([^\"]+)\"/);
        metrics.fastFinals.push({ timestamp, segment: match ? match[1] : undefined, text });
      }
      if (text.includes("Prefix committed")) {
        metrics.speakerEvents.push({ timestamp, type: "prefix-commit", text });
      }
      if (text.includes("Recognized (final)")) {
        metrics.speakerEvents.push({ timestamp, type: "final", text });
      }
    } catch {}
  });

  listenerPage.on("console", (msg) => {
    const text = msg.text();
    const timestamp = now();
    try {
      if (text.includes("[listener] Hard patch rendered")) {
        const jsonMatch = text.match(/\{[^}]+\}/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          metrics.translations.push({ timestamp, unitId: data.unitId, text: data.text });
        }
      }
      if (text.includes("[listener] TTS enqueued")) {
        const jsonMatch = text.match(/\{[^}]+\}/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          metrics.ttsQueue.push({ timestamp, queueSize: data.queueSize, unitId: data.unitId });
        }
      }
      if (text.includes("[listener] TTS playback started")) {
        // Just surface in events for now
        const jsonMatch = text.match(/\{[^}]+\}/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          metrics.listenerEvents.push({ timestamp, type: "tts-play", data });
        }
      }
    } catch {}
  });

  // Navigate
  // Use SPA routes and pass room via URL
  await speakerPage.goto(`${serverUrl}/speaker?room=${encodeURIComponent(roomId)}`);
  await listenerPage.goto(`${serverUrl}/listener?room=${encodeURIComponent(roomId)}`);

  // Configure forms
  // Speaker SPA config is driven by room meta; just start
  // Listener SPA: click target language button if available; else skip
  try {
    const label = langNameFromCode(targetLang);
    await listenerPage.click(`button:has-text("${label}")`, { timeout: 2000 });
  } catch {}
  try { await listenerPage.check(sel.ttsToggle); } catch {}

  // Start capture and connect listener
  await speakerPage.click(sel.startButton);
  // Optional: wait for listening state if present
  try { await speakerPage.waitForSelector(`${sel.speakerListeningStatus}:has-text("Listening")`, { timeout: 10000 }); } catch {}

  await listenerPage.click(sel.connectButton);
  // Prefer text match for SPA status
  try { await listenerPage.waitForSelector('text=Status: Connected', { timeout: 10000 }); } catch {}

  // Watch for some time, or until we have some translations
  const started = now();
  while (now() - started < timeoutMs) {
    // Heuristic early-stop if we got enough translations and some fast-finals
    if (metrics.translations.length >= 3 && metrics.fastFinals.length >= 1) {
      break;
    }
    await listenerPage.waitForTimeout(500);
  }

  metrics.endedAt = now();
  metrics.summary = {
    durationMs: metrics.endedAt - metrics.startedAt,
    translations: metrics.translations.length,
    fastFinals: metrics.fastFinals.length,
    ttsEvents: metrics.ttsQueue.length,
  };

  return metrics;
}

async function main() {
  const server = new Server({ name: "mcp-playwright-server", version: "0.1.0" }, { capabilities: { tools: {} } });

  // Tool: run_fake_mic_session
  server.tool(
    "run_fake_mic_session",
    {
      description: "Launch speaker + listener pages, inject audio as microphone, and collect translation/TTS metrics.",
      inputSchema: RunSessionSchema,
    },
    async ({ input }) => {
      try {
        const result = await runFakeMicSession(input, server);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        await ensureClosed();
        const message = err?.stack || String(err);
        return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
      } finally {
        await ensureClosed();
      }
    }
  );

  // Tool: close (cleanup any open browser/session)
  server.tool(
    "close",
    { description: "Close browser and contexts.", inputSchema: z.object({}) },
    async () => {
      await ensureClosed();
      return { content: [{ type: "text", text: "closed" }] };
    }
  );

  // Tool: ping
  server.tool(
    "ping",
    { description: "Health check.", inputSchema: z.object({ msg: z.string().optional() }) },
    async ({ input }) => {
      return { content: [{ type: "text", text: input?.msg || "pong" }] };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
