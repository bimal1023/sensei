export type Status = "idle" | "listening" | "thinking" | "speaking";

/** One NDJSON line from a streamed turn (/api/talk, /api/chat, POST /api/checkin). */
export type StreamEvent =
  | { type: "transcript"; text: string }
  | { type: "delta"; text: string }
  | { type: "audio"; audio: string }
  | { type: "error"; message: string };

export type OnEvent = (e: StreamEvent) => void;

export type Goal = {
  id: number;
  title: string;
  target: string;
  cadence: string;
  done_last_7_days: number;
  entries_last_7_days: number;
  last_update: string | null;
};

export type InterviewKind = "dsa" | "behavioral" | "mixed";

export type TopicStat = {
  kind: "dsa" | "behavioral";
  topic: string;
  attempts: number;
  clarity: number;
  correctness: number;
  score: number;
};

export type InterviewState = {
  active: { id: number; kind: InterviewKind; answered: number } | null;
  topics: TopicStat[]; // weakest first
};

export type Difficulty = "easy" | "medium" | "hard";
export type ProblemStatus = "todo" | "attempted" | "solved";

export type Problem = {
  id: number;
  title: string;
  difficulty: Difficulty | null;
  topic: string | null;
  status: ProblemStatus;
  description: string | null;
  code: string | null;
  notes: string | null;
  confidence: number | null;
  attempts: number;
  updated: number;
  next_review: number | null;
};

export type ProblemsState = {
  problems: Problem[];
  stats: { solved: number; attempted: number; by_difficulty: Record<string, number> };
  due: Pick<Problem, "id" | "title" | "difficulty" | "topic" | "confidence">[];
};

export type RunResult = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  ms: number;
};

/** Live code-editor state sent with each turn so Sensei can tutor on it. */
export type CodeContext = {
  code: string;
  problem: Partial<Problem> | null;
  run: RunResult | null;
};

export const DSA_TOPICS = [
  "arrays & hashing", "two pointers", "sliding window", "stack", "binary search",
  "linked list", "trees", "tries", "heap", "backtracking", "graphs",
  "dynamic programming", "greedy", "intervals", "bit manipulation", "math",
];

export type RealtimeSession = {
  client_secret: string;
  model: string;
  call_started: number;
  checkin: string | null; // daily check-in instruction, if one is due
};

/** What the backend needs to rebuild a live call's instructions. */
export type RealtimeState = {
  context: CodeContext | null;
  query: string | null;
  call_started: number;
};

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

/** Read an NDJSON response, calling onEvent for each line as it arrives. */
async function stream(req: Promise<Response>, onEvent: OnEvent): Promise<void> {
  const res = await req;
  if (!res.ok || !res.body) throw new Error((await res.text()) || res.statusText);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
  }
  if (buf.trim()) onEvent(JSON.parse(buf));
}

function post<T>(path: string, body: unknown): Promise<T> {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(json<T>);
}

export const api = {
  chat(text: string, onEvent: OnEvent, signal?: AbortSignal, context?: CodeContext | null): Promise<void> {
    return stream(
      fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, context }),
        signal,
      }),
      onEvent
    );
  },
  checkinDue(): Promise<{ due: boolean }> {
    return fetch(`${API}/api/checkin`).then(json<{ due: boolean }>);
  },
  checkin(onEvent: OnEvent, signal?: AbortSignal): Promise<void> {
    return stream(fetch(`${API}/api/checkin`, { method: "POST", signal }), onEvent);
  },
  interview(): Promise<InterviewState> {
    return fetch(`${API}/api/interview`).then(json<InterviewState>);
  },
  startInterview(kind: InterviewKind, onEvent: OnEvent, signal?: AbortSignal): Promise<void> {
    return stream(
      fetch(`${API}/api/interview/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
        signal,
      }),
      onEvent
    );
  },
  endInterview(onEvent: OnEvent, signal?: AbortSignal): Promise<void> {
    return stream(fetch(`${API}/api/interview/end`, { method: "POST", signal }), onEvent);
  },
  run(code: string): Promise<RunResult> {
    return fetch(`${API}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }).then(json<RunResult>);
  },
  problems(): Promise<ProblemsState> {
    return fetch(`${API}/api/problems`).then(json<ProblemsState>);
  },
  saveProblem(p: Partial<Problem>): Promise<Problem> {
    return fetch(`${API}/api/problems`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    }).then(json<Problem>);
  },
  deleteProblem(id: number): Promise<void> {
    return fetch(`${API}/api/problems/${id}`, { method: "DELETE" }).then(() => {});
  },
  realtimeSession(context: CodeContext | null): Promise<RealtimeSession> {
    return post<RealtimeSession>("/api/realtime/session", { context });
  },
  realtimeInstructions(body: RealtimeState): Promise<{ instructions: string }> {
    return post("/api/realtime/instructions", body);
  },
  realtimeTool(
    body: RealtimeState & { name: string; arguments: string }
  ): Promise<{ output: string; instructions: string }> {
    return post("/api/realtime/tool", body);
  },
  realtimeLog(role: "user" | "assistant", text: string): Promise<unknown> {
    return post("/api/realtime/log", { role, text }).catch(() => {});
  },
  goals(): Promise<Goal[]> {
    return fetch(`${API}/api/goals`).then(json<Goal[]>);
  },
  history(): Promise<{ role: string; content: string }[]> {
    return fetch(`${API}/api/history`).then(json<{ role: string; content: string }[]>);
  },
};
