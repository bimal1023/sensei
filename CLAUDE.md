# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Sensei

A voice-first 3D avatar mentor. The user talks (or types) to Sensei, which transcribes speech, runs an OpenAI tool-calling agent backed by persistent SQLite memory (facts, goals, progress, chat history), and replies with TTS audio that drives the avatar's lip-sync.

**Stack:** FastAPI (Python 3.10+) backend · Next.js 14 App Router + React Three Fiber + Monaco (TypeScript) frontend · OpenAI for chat, Whisper STT, TTS, and embeddings · SQLite for memory

## Commands

**Backend** (from `backend/`):
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env              # set OPENAI_API_KEY
uvicorn main:app --reload --port 8000
```

**Frontend** (from `frontend/`):
```bash
npm install
cp .env.local.example .env.local  # NEXT_PUBLIC_API_URL, defaults to http://localhost:8000
npm run dev                       # http://localhost:3000
npm run build                     # also the type-check (strict TS); no separate lint/test scripts
```

There is no test suite. Quick backend smoke test: `curl localhost:8000/api/health`, or `curl -X POST localhost:8000/api/chat -H 'Content-Type: application/json' -d '{"text":"hi"}'`.

## Architecture

### Request flow
`POST /api/talk` (multipart `audio`) → Whisper transcription → `Agent.respond_stream()` → per-sentence TTS. `POST /api/chat` does the same from `{text}`, and `POST /api/checkin` runs the agent with no user text plus `CHECKIN_INSTRUCTION` (passed as `respond_stream(instruction=...)`), marking today's check-in done when the stream finishes. All three return NDJSON via `stream_reply()` in `main.py`: a `transcript` event, `delta` events as tokens arrive, `audio` events (base64 MP3, one per sentence, in order), and `error` on failure. Sentences are sent to a TTS thread pool as soon as they complete, and TTS failures just skip that clip.

### Backend (`backend/`)
- **`main.py`**: constructs a single module-level `OpenAI` client, `Memory`, and `Agent` at import time. `load_dotenv()` must run before the `agent`/`memory` imports because both read env vars at module load (hence the `# noqa: E402`s).
- **`agent.py`**: `SYSTEM_PROMPT` is rebuilt every turn with semantically recalled memories and `goals_summary()` injected. Tools (`remember`, `add_goal`, `log_progress`, `set_goal_status`, `recall`) are defined in the `TOOLS` list and dispatched in `_run_tool()`; adding a tool means updating both. Streamed tool-call fragments are reassembled by `index` before execution. The tool loop is capped at 5 iterations, the reply is saved to history in a `finally` block (so partial replies survive client aborts), and tool errors are returned to the model as strings rather than raised. Replies are meant to be spoken: 1–3 sentences, no markdown.
- **`memory.py`**: tables `memories`, `goals`, `progress`, `messages`, `kv`, `interviews` and `attempts`. One SQLite connection (`check_same_thread=False`), schema created inline via `CREATE TABLE IF NOT EXISTS`, with no migrations. Changing the schema means deleting `sensei.db` or writing a manual migration. Embeddings are stored as JSON text, and `recall()` does brute-force cosine similarity in numpy (threshold 0.2), falling back to the most recent facts if embeddings are unavailable. Embedding failures must never crash a conversation. Check-in state lives in the `kv` table as `last_checkin`.

### Live calls (Realtime API)
The mic button opens a WebRTC call straight from the browser to OpenAI (`frontend/lib/useRealtime.ts`). The backend never carries the audio. It does four things:
- **`/api/realtime/session`** mints an ephemeral key via `POST /v1/realtime/client_secrets`, with the full session config (model, voice, `semantic_vad` turn detection with `interrupt_response`, input transcription, noise reduction, `REALTIME_TOOLS`). It also returns the check-in instruction if one is due, and marks it done.
- **`/api/realtime/instructions`** rebuilds `Agent.realtime_instructions()`: the current mode prompt, `REALTIME_RULES`, code context, and pre-call history (`recent_messages(before=call_started)`, because the Realtime session holds the in-call conversation itself). The client pushes it with `session.update` on every `speech_started` and before typed messages.
- **`/api/realtime/tool`** runs `Agent.run_tool()` for function calls found in `response.done`, then returns fresh instructions, since tools can switch modes. The client sends `function_call_output` items followed by one `response.create`.
- **`/api/realtime/log`** saves user and assistant transcripts to `messages`, so memory and history stay continuous with typed chat.

Audio details: remote audio plays through an `<audio>` element so the browser's echo cancellation can subtract it, and is also fed into the lip-sync `AnalyserNode`, which is **not** connected to the speakers. Streamed-TTS clips connect to both the analyser and `destination` themselves. Transcript lines are keyed by Realtime `item_id` (`upsertLine`), because the user transcript can arrive after the reply starts. The typed pipeline (`/api/chat` with streamed TTS) still serves typed input outside a call. `/api/talk` (push-to-talk) remains in the backend but the UI no longer uses it.

### Mock interview mode
While a row in `interviews` has `ended IS NULL`, `Agent._system_for()` swaps the mentor prompt for `INTERVIEW_PROMPT`. The model invents every question itself, with the topic weakness list (`Memory.topic_stats()`) and recent questions injected to steer it and avoid repeats. After each answer it calls `score_answer` (clarity and correctness 1–5, `topic` restricted to `DSA_TOPICS + BEHAVIORAL_TOPICS` so stats aggregate cleanly), and it calls `start_interview`/`end_interview` for voice control. The system prompt is rebuilt after every tool round, so a mode switch takes effect within the same turn. `/api/interview/start` and `/end` drive the same flow from the UI buttons via one-off `instruction` messages (`INTERVIEW_START`, `INTERVIEW_END`), just like the check-in uses `CHECKIN_INSTRUCTION`.

### Code lab + LeetCode tracker
- `POST /api/run` writes the code to a temp dir and runs it with `sys.executable` (the backend's own interpreter), with a 10s timeout and output clipped to 20k characters. It is **unsandboxed arbitrary code execution**, acceptable only because the app is local.
- `problems` table (`Memory.save_problem`) upserts by id, else by case-insensitive title. `attempts` and `next_review` only change on a real attempt (status change, confidence change, or `new_attempt=True`), so repeated Saves don't reset the review schedule. `REVIEW_DAYS` maps confidence 1–5 to review intervals, and `due_reviews()` feeds the mentor prompt.
- When the code panel is open, the frontend sends `context` (`{code, problem, run}`) with `/api/chat` (JSON) and `/api/talk` (a JSON-string form field). `Agent` appends `format_code_context()` (the live editor state plus tutor rules) as an extra system message. `log_problem` without a title, or with the open problem's title, updates the open problem and saves the editor's code.

### Frontend (`frontend/`)
- **`app/page.tsx`**: the entire UI and state machine. `Status` is `idle | listening | thinking | speaking`. The `AudioContext` and `AnalyserNode` are created in the "Start session" click handler because browsers require a user gesture before audio playback. `run()` consumes a streamed turn: deltas grow the `live` assistant line, and audio clips are decoded in order (`decodeChain`) and scheduled back to back on the AudioContext timeline (`nextStart`). Tapping the mic while speaking aborts the fetch and stops all queued clips. Status returns to `idle` only once streaming is done and no clips remain.
- **`components/Scene.tsx`**: loaded via `next/dynamic` with `ssr: false` (Three.js cannot render on the server).
- **`components/Avatar.tsx`**: procedural head. `useFrame` reads time-domain data from the shared analyser ref, computes RMS, and scales the mouth mesh. Halo color reflects `status`. The analyser is passed as a ref, not state, so per-frame reads never trigger React re-renders.
- **`components/CodeLab.tsx`**: Monaco editor (`@monaco-editor/react`, which loads Monaco from a CDN at runtime), the problem metadata form, Run/Save (⌘↵/⌘S via refs so the keybindings see fresh state), and Hint/Review/Explain buttons that call `ask()`. It reports editor state up through `onContext`, and `page.tsx` keeps it in a ref so it's read only when a turn is sent. Status and confidence changes made by Sensei are merged in without touching the code being edited.
- **`lib/api.ts`**: typed fetch wrappers, the NDJSON `stream()` reader, and shared types (`StreamEvent`, `Goal`, `Status`). Keep `Goal` in sync with `Memory.goals_summary()` and `TopicStat` in sync with `Memory.topic_stats()`. `refreshPanels()` reloads goals and interview state after every turn, since both change through agent tools.
- **`lib/useRealtime.ts`**: live call hook (`start`/`stop`/`sendText`). It maps Realtime server events to `Status` (`speech_started` → listening, `speech_stopped` → thinking, `output_audio_buffer.started` → speaking). In a call, typed text and the Hint/Review/interview buttons go through `sendText` (see `say()` in `page.tsx`).
- Styling is plain CSS in `app/globals.css` (no Tailwind). Import alias `@/*` maps to the frontend root.

## Configuration

Backend env vars (see `backend/.env.example`). Live calls use `OPENAI_REALTIME_MODEL` (default `gpt-realtime-2.1`), `OPENAI_REALTIME_VOICE` (`marin`; Realtime voices differ from TTS voices), `OPENAI_REALTIME_STT_MODEL`, `REALTIME_VAD_EAGERNESS` (`low|medium|high|auto`) and `REALTIME_NOISE_REDUCTION` (`near_field|far_field`). Also: `OPENAI_API_KEY` (required), `SENSEI_USER_NAME`, `OPENAI_CHAT_MODEL` (default `gpt-4o-mini`), `OPENAI_STT_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE`, `OPENAI_EMBED_MODEL`, `SENSEI_DB` (default `sensei.db`, relative to the working directory), and `CORS_ORIGINS` (comma-separated, default `http://localhost:3000`).

## Notes

- Single-user app with no auth. All state lives in the local SQLite file, which is gitignored (`*.db`).
- The README roadmap lists planned work: a Ready Player Me GLB avatar with viseme lip-sync, a weekly review, personas, screen-aware coaching, integrations as tools (GitHub, Calendar, Gmail), and proactive nudges.
