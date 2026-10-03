"use client";
import dynamic from "next/dynamic";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  CodeContext,
  Goal,
  InterviewKind,
  InterviewState,
  OnEvent,
  ProblemsState,
  Status,
} from "@/lib/api";
import { useRealtime } from "@/lib/useRealtime";

const Scene = dynamic(() => import("@/components/Scene"), { ssr: false });
const CodeLab = dynamic(() => import("@/components/CodeLab"), { ssr: false });

// `live` marks a line still being streamed in; `id` ties call transcript events to their line.
type Line = { role: "user" | "assistant"; text: string; live?: boolean; id?: string };

const INTERVIEW_KINDS: { kind: InterviewKind; label: string }[] = [
  { kind: "dsa", label: "DSA" },
  { kind: "behavioral", label: "Behavioral" },
  { kind: "mixed", label: "Mixed" },
];

const CALL_LABEL: Record<Status, string> = {
  idle: "Connecting…",
  listening: "Listening… just talk",
  thinking: "Thinking…",
  speaking: "Speaking… talk to interrupt",
};

const STATUS_LABEL: Record<Status, string> = {
  idle: "Tap the mic to start a call",
  listening: "Listening… tap to send",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

export default function Home() {
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [interview, setInterview] = useState<InterviewState>({ active: null, topics: [] });
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [codeOpen, setCodeOpen] = useState(false);
  const [lc, setLc] = useState<ProblemsState>({
    problems: [],
    stats: { solved: 0, attempted: 0, by_difficulty: {} },
    due: [],
  });
  const [problemId, setProblemId] = useState<number | null>(null);
  const codeCtx = useRef<CodeContext | null>(null);
  const setCodeCtx = useCallback((c: CodeContext) => {
    codeCtx.current = c;
  }, []);

  const ctx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const sources = useRef(new Set<AudioBufferSourceNode>()); // scheduled/playing clips
  const nextStart = useRef(0); // AudioContext time where the next clip should begin
  const decodeChain = useRef(Promise.resolve()); // keeps clips in arrival order
  const streaming = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  const [inCall, setInCall] = useState(false);

  // Goals, interview state, and problems change through agent tools, so refresh after every turn.
  const refreshPanels = useCallback(() => {
    api.goals().then(setGoals).catch(() => {});
    api.interview().then(setInterview).catch(() => {});
    api.problems().then(setLc).catch(() => {});
  }, []);

  useEffect(() => {
    refreshPanels();
    api
      .history()
      .then((h) =>
        setLines(
          h.map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.content }))
        )
      )
      .catch(() => setError("Can't reach the Sensei backend. Is it running on :8000?"));
  }, [refreshPanels]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  // Idle once the reply has finished streaming and the last clip has played.
  const settle = useCallback(() => {
    if (!streaming.current && sources.current.size === 0) setStatus("idle");
  }, []);

  // Schedule a sentence's audio right after the previous one, so speech is gapless.
  const enqueueAudio = useCallback(
    (b64: string, signal: AbortSignal) => {
      decodeChain.current = decodeChain.current.then(async () => {
        const c = ctx.current;
        if (!c) return;
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const buffer = await c.decodeAudioData(bytes.buffer).catch(() => null);
        if (!buffer || signal.aborted) return;
        const src = c.createBufferSource();
        src.buffer = buffer;
        src.connect(analyser.current!);
        src.connect(c.destination);
        const at = Math.max(c.currentTime, nextStart.current);
        src.start(at);
        nextStart.current = at + buffer.duration;
        sources.current.add(src);
        src.onended = () => {
          sources.current.delete(src);
          settle();
        };
        setStatus("speaking");
      });
    },
    [settle]
  );

  const stopAudio = () => {
    abort.current?.abort();
    sources.current.forEach((s) => s.stop());
    sources.current.clear();
    nextStart.current = 0;
  };

  const run = useCallback(
    async (fn: (onEvent: OnEvent, signal: AbortSignal) => Promise<void>) => {
      setError(null);
      setStatus("thinking");
      const ac = new AbortController();
      abort.current = ac;
      streaming.current = true;
      let reply = "";
      try {
        await fn((e) => {
          if (e.type === "transcript") {
            if (e.text) setLines((l) => [...l, { role: "user", text: e.text }]);
          } else if (e.type === "delta") {
            reply += e.text;
            const text = reply;
            setLines((l) =>
              l.at(-1)?.live
                ? [...l.slice(0, -1), { role: "assistant", text, live: true }]
                : [...l, { role: "assistant", text, live: true }]
            );
          } else if (e.type === "audio") {
            enqueueAudio(e.audio, ac.signal);
          } else if (e.type === "error") {
            setError(e.message);
          }
        }, ac.signal);
      } catch (e) {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLines((l) => l.map((x) => (x.live ? { ...x, live: false } : x)));
        refreshPanels();
        await decodeChain.current;
        streaming.current = false;
        settle();
      }
    },
    [enqueueAudio, refreshPanels, settle]
  );

  // Audio must be unlocked by a user gesture, so the session starts on click.
  const start = async () => {
    const c = new AudioContext();
    const a = c.createAnalyser();
    a.fftSize = 1024; // lip-sync only: audio reaches the speakers by its own route
    ctx.current = c;
    analyser.current = a;
    setStarted(true);
    try {
      const { due } = await api.checkinDue();
      if (due) await run(api.checkin);
    } catch {
      setError("Can't reach the Sensei backend. Is it running on :8000?");
    }
  };

  // Call transcript events arrive by item id, and user text can land after the reply starts.
  const upsertLine = (id: string, role: Line["role"], text: (prev: string) => string, live: boolean) =>
    setLines((l) => {
      const i = l.findIndex((x) => x.id === id);
      if (i === -1) return [...l, { id, role, text: text(""), live }];
      const next = l.slice();
      next[i] = { ...next[i], text: text(next[i].text), live };
      return next;
    });

  const call = useRealtime({
    audioCtx: () => ctx.current,
    analyser: () => analyser.current,
    codeContext: () => editorContext(),
    onStatus: setStatus,
    onUser: (id, text) => {
      if (text === null) upsertLine(id, "user", () => "…", true);
      else if (text) upsertLine(id, "user", () => text, false);
      else setLines((l) => l.filter((x) => x.id !== id)); // nothing intelligible was said
    },
    onAssistant: (id, delta, done) => upsertLine(id, "assistant", (p) => p + delta, !done),
    onToolsRan: refreshPanels,
    onError: setError,
    onEnd: () => {
      setInCall(false);
      refreshPanels();
    },
  });

  useEffect(() => call.stop, [call.stop]); // hang up if the page unmounts

  const toggleMic = async () => {
    if (inCall) {
      call.stop();
      return;
    }
    if (status === "speaking") {
      stopAudio(); // interrupt a typed-chat reply
      return;
    }
    if (status !== "idle") return;
    setError(null);
    setInCall(true);
    try {
      await call.start();
    } catch (e) {
      setInCall(false);
      setStatus("idle");
      setError(e instanceof Error ? e.message : "Couldn't start the call. Is the mic allowed?");
    }
  };

  // Typed turns: go into the live call if there is one, otherwise the streamed chat pipeline.
  const canSend = inCall ? status === "listening" : status === "idle";
  const say = (text: string) => {
    if (!canSend) return;
    if (inCall) call.sendText(text);
    else run((onEvent, signal) => api.chat(text, onEvent, signal, editorContext()));
  };

  // Sensei only sees the editor while the code panel is open.
  const editorContext = () => (codeOpen ? codeCtx.current : null);

  const startInterview = (kind: InterviewKind) =>
    inCall
      ? say(`Let's start a ${kind} mock interview.`)
      : run((onEvent, signal) => api.startInterview(kind, onEvent, signal));
  const endInterview = () =>
    inCall ? say("Let's end the interview now.") : run((onEvent, signal) => api.endInterview(onEvent, signal));

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !canSend) return;
    setDraft("");
    say(text);
  };

  const openProblem = (id: number) => {
    setProblemId(id);
    setCodeOpen(true);
  };

  return (
    <main className={`shell${codeOpen ? " with-code" : ""}`}>
      <section className="stage">
        <header className="brand">
          <span className="dot" data-status={status} />
          Sensei
          <button className="chip" onClick={() => setCodeOpen((o) => !o)}>
            {codeOpen ? "Close code" : "</> Code"}
          </button>
        </header>
        <div className="canvas">
          <Scene analyser={analyser} status={status} />
        </div>

        {!started ? (
          <button className="start" onClick={start}>
            Start session
          </button>
        ) : (
          <div className="controls">
            <button
              className="mic"
              data-status={status}
              data-call={inCall}
              onClick={toggleMic}
              disabled={!inCall && status === "thinking"}
              aria-label={inCall ? "End call" : "Start a call with Sensei"}
            >
              <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                {inCall ? (
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                ) : (
                  <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
                )}
              </svg>
            </button>
            <p className="status">
              {inCall ? CALL_LABEL[status] : STATUS_LABEL[status]}
              {inCall && <span className="muted small"> · tap to hang up</span>}
            </p>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      {codeOpen && (
        <CodeLab
          problems={lc.problems}
          selectedId={problemId}
          onSelect={setProblemId}
          onSaved={refreshPanels}
          onContext={setCodeCtx}
          ask={say}
          busy={!started || !canSend}
        />
      )}

      <aside className="panel">
        <div className="card">
          <h2>Goals</h2>
          {goals.length === 0 ? (
            <p className="muted">No goals yet. Tell Sensei what you want to grow in.</p>
          ) : (
            <ul className="goals">
              {goals.map((g) => (
                <li key={g.id}>
                  <div className="goal-title">{g.title}</div>
                  <div className="muted">
                    {g.target || g.cadence} · {g.done_last_7_days} done this week
                  </div>
                  {g.last_update && <div className="muted small">Last: {g.last_update}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>Mock interview</h2>
          {interview.active ? (
            <div className="interview-live">
              <span>
                <span className="live-dot" /> {interview.active.kind.toUpperCase()} ·{" "}
                {interview.active.answered} answered
              </span>
              <button className="chip" onClick={endInterview} disabled={!started || !canSend}>
                End
              </button>
            </div>
          ) : (
            <div className="chips">
              {INTERVIEW_KINDS.map(({ kind, label }) => (
                <button
                  key={kind}
                  className="chip"
                  onClick={() => startInterview(kind)}
                  disabled={!started || !canSend}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {interview.topics.length > 0 && (
            <ul className="topics">
              {interview.topics.slice(0, 5).map((t) => (
                <li key={`${t.kind}-${t.topic}`}>
                  <span className="topic-name">{t.topic}</span>
                  <span className="bar">
                    <span style={{ width: `${(t.score / 5) * 100}%` }} data-weak={t.score < 3} />
                  </span>
                  <span className="muted small">{t.score.toFixed(1)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>LeetCode</h2>
          <p className="muted">
            {lc.stats.solved} solved
            {(["easy", "medium", "hard"] as const)
              .filter((d) => lc.stats.by_difficulty[d])
              .map((d) => ` · ${lc.stats.by_difficulty[d]} ${d}`)
              .join("")}
            {lc.stats.attempted > 0 && ` · ${lc.stats.attempted} in progress`}
          </p>
          {lc.due.length > 0 && (
            <ul className="due">
              {lc.due.map((p) => (
                <li key={p.id}>
                  <button className="link" onClick={() => openProblem(p.id)}>
                    Review: {p.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card log">
          <h2>Conversation</h2>
          <div className="lines">
            {lines.map((l, i) => (
              <p key={l.id ?? i} className={`line ${l.role}${l.live ? " live" : ""}`}>
                {l.text}
              </p>
            ))}
            <div ref={logEnd} />
          </div>
          <form onSubmit={send} className="composer">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={started ? "Or type to Sensei…" : "Start a session first"}
              disabled={!started}
            />
          </form>
        </div>
      </aside>
    </main>
  );
}
