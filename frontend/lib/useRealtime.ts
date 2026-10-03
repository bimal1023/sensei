"use client";
import { useCallback, useRef } from "react";
import { api, CodeContext, Status } from "./api";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

// Realtime server events are loosely typed; we only read the fields we need.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RtEvent = { type: string; [key: string]: any };

type FunctionCall = { type: "function_call"; name: string; call_id: string; arguments: string };

export type RealtimeHandlers = {
  audioCtx: () => AudioContext | null;
  /** Lip-sync analyser. Remote audio is fed into it but not routed to the speakers. */
  analyser: () => AnalyserNode | null;
  codeContext: () => CodeContext | null;
  onStatus: (s: Status) => void;
  /** User speech: text is null while it's still being transcribed. */
  onUser: (id: string, text: string | null) => void;
  onAssistant: (id: string, delta: string, done: boolean) => void;
  onToolsRan: () => void;
  onError: (message: string) => void;
  onEnd: () => void;
};

/**
 * A live voice call over WebRTC with the OpenAI Realtime API. The backend mints a
 * short-lived key and runs tools. The model hears the mic directly, detects when you
 * stop talking (semantic VAD), streams speech back, and stops when you interrupt.
 */
export function useRealtime(handlers: RealtimeHandlers) {
  const h = useRef(handlers);
  h.current = handlers;

  const pc = useRef<RTCPeerConnection | null>(null);
  const dc = useRef<RTCDataChannel | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const callStarted = useRef(0);
  const lastUserText = useRef<string | null>(null);

  const send = (event: object) => {
    if (dc.current?.readyState === "open") dc.current.send(JSON.stringify(event));
  };

  const state = () => ({
    context: h.current.codeContext(),
    query: lastUserText.current,
    call_started: callStarted.current,
  });

  const setInstructions = (instructions: string) =>
    send({ type: "session.update", session: { type: "realtime", instructions } });

  /** Push fresh memories, goals, mode, and code context into the session. */
  const refreshInstructions = useCallback(async () => {
    try {
      setInstructions((await api.realtimeInstructions(state())).instructions);
    } catch {
      /* keep the previous instructions */
    }
  }, []);

  const runTools = async (calls: FunctionCall[]) => {
    h.current.onStatus("thinking");
    let instructions: string | null = null;
    for (const call of calls) {
      let output = "tool error";
      try {
        const res = await api.realtimeTool({ ...state(), name: call.name, arguments: call.arguments });
        output = res.output;
        instructions = res.instructions;
      } catch (e) {
        output = `tool error: ${e instanceof Error ? e.message : e}`;
      }
      send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.call_id, output },
      });
    }
    if (instructions) setInstructions(instructions); // tools can switch mode (e.g. interview)
    send({ type: "response.create" });
    h.current.onToolsRan();
  };

  const onEvent = (ev: RtEvent) => {
    const H = h.current;
    switch (ev.type) {
      case "input_audio_buffer.speech_started":
        H.onStatus("listening");
        refreshInstructions(); // lands before the reply, which waits for you to stop talking
        break;
      case "input_audio_buffer.speech_stopped":
        H.onStatus("thinking");
        break;
      case "input_audio_buffer.committed":
        H.onUser(ev.item_id, null); // placeholder keeps lines in spoken order
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = (ev.transcript || "").trim();
        H.onUser(ev.item_id, text);
        if (text) {
          lastUserText.current = text;
          api.realtimeLog("user", text);
        }
        break;
      }
      case "response.output_audio_transcript.delta":
        H.onAssistant(ev.item_id, ev.delta || "", false);
        break;
      case "response.output_audio_transcript.done":
        H.onAssistant(ev.item_id, "", true);
        api.realtimeLog("assistant", ev.transcript || "");
        break;
      case "output_audio_buffer.started":
        H.onStatus("speaking");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        H.onStatus("listening");
        break;
      case "response.done": {
        const calls = (ev.response?.output || []).filter(
          (o: RtEvent) => o.type === "function_call"
        ) as FunctionCall[];
        if (calls.length) runTools(calls);
        break;
      }
      case "error":
        // Harmless race: cancelling a response that already finished.
        if (ev.error?.code !== "response_cancel_not_active") {
          H.onError(ev.error?.message || "Realtime error");
        }
        break;
    }
  };

  const stop = useCallback(() => {
    if (!pc.current) return;
    dc.current?.close();
    pc.current.getSenders().forEach((s) => s.track?.stop());
    pc.current.close();
    if (audioEl.current) audioEl.current.srcObject = null;
    pc.current = null;
    dc.current = null;
    h.current.onStatus("idle");
    h.current.onEnd();
  }, []);

  const start = useCallback(async () => {
    const H = h.current;
    const session = await api.realtimeSession(H.codeContext());
    callStarted.current = session.call_started;
    lastUserText.current = null;

    const peer = new RTCPeerConnection();
    pc.current = peer;

    // Play through a media element so the browser's echo cancellation knows what the
    // speakers are saying (it can't see Web Audio output). The analyser only listens.
    const el = audioEl.current ?? new Audio();
    el.autoplay = true;
    audioEl.current = el;
    peer.ontrack = (e) => {
      const [stream] = e.streams;
      el.srcObject = stream;
      const c = H.audioCtx();
      const a = H.analyser();
      if (c && a) c.createMediaStreamSource(stream).connect(a);
    };

    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    mic.getTracks().forEach((t) => peer.addTrack(t, mic));

    const channel = peer.createDataChannel("oai-events");
    dc.current = channel;
    channel.onmessage = (m) => onEvent(JSON.parse(m.data));
    channel.onopen = () => {
      h.current.onStatus("listening");
      if (session.checkin) {
        send({
          type: "conversation.item.create",
          item: { type: "message", role: "system", content: [{ type: "input_text", text: session.checkin }] },
        });
        send({ type: "response.create" });
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") {
        h.current.onError("Call dropped.");
        stop();
      }
    };

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const res = await fetch(CALLS_URL, {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${session.client_secret}`, "Content-Type": "application/sdp" },
    });
    if (!res.ok) {
      stop();
      throw new Error(`Couldn't start the call: ${await res.text()}`);
    }
    await peer.setRemoteDescription({ type: "answer", sdp: await res.text() });
  }, [stop]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Typed message (or a Hint/Review button) during a call. */
  const sendText = useCallback(
    async (text: string) => {
      h.current.onUser(`typed-${Date.now()}`, text);
      h.current.onStatus("thinking");
      lastUserText.current = text;
      api.realtimeLog("user", text);
      await refreshInstructions(); // so it sees the latest code
      send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      });
      send({ type: "response.create" });
    },
    [refreshInstructions]
  );

  return { start, stop, sendText, active: () => pc.current !== null };
}
