"""Sensei API: voice in -> transcript -> agent -> speech out."""

import base64
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from collections import deque

import httpx
from concurrent.futures import ThreadPoolExecutor

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from openai import OpenAI  # noqa: E402
from typing import Literal  # noqa: E402

from pydantic import BaseModel  # noqa: E402

from agent import (  # noqa: E402
    CHECKIN_INSTRUCTION,
    REALTIME_TOOLS,
    INTERVIEW_END,
    INTERVIEW_START,
    USER_NAME,
    Agent,
)
from memory import Memory  # noqa: E402

CHAT_MODEL = os.getenv("OPENAI_CHAT_MODEL", "gpt-4o-mini")
STT_MODEL = os.getenv("OPENAI_STT_MODEL", "whisper-1")
TTS_MODEL = os.getenv("OPENAI_TTS_MODEL", "tts-1")
TTS_VOICE = os.getenv("OPENAI_TTS_VOICE", "onyx")
EMBED_MODEL = os.getenv("OPENAI_EMBED_MODEL", "text-embedding-3-small")
REALTIME_MODEL = os.getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-2.1")
REALTIME_VOICE = os.getenv("OPENAI_REALTIME_VOICE", "marin")
REALTIME_STT_MODEL = os.getenv("OPENAI_REALTIME_STT_MODEL", "gpt-4o-mini-transcribe")
# semantic_vad eagerness: low waits longer before answering, high answers sooner.
REALTIME_EAGERNESS = os.getenv("REALTIME_VAD_EAGERNESS", "auto")
REALTIME_NOISE = os.getenv("REALTIME_NOISE_REDUCTION", "far_field")  # near_field for headsets

client = OpenAI()
memory = Memory(client, EMBED_MODEL)
agent = Agent(client, CHAT_MODEL, memory)

app = FastAPI(title="Sensei")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


class TextIn(BaseModel):
    text: str
    context: dict | None = None  # code editor state, when the code panel is open


class RealtimeIn(BaseModel):
    context: dict | None = None
    query: str | None = None  # last thing the user said, for memory recall
    call_started: float = 0.0


class RealtimeToolIn(RealtimeIn):
    name: str
    arguments: str = "{}"


class LogIn(BaseModel):
    role: Literal["user", "assistant"]
    text: str


class RunIn(BaseModel):
    code: str
    stdin: str = ""


class ProblemIn(BaseModel):
    id: int | None = None
    title: str | None = None
    difficulty: Literal["easy", "medium", "hard"] | None = None
    topic: str | None = None
    status: Literal["todo", "attempted", "solved"] | None = None
    description: str | None = None
    code: str | None = None
    notes: str | None = None
    confidence: int | None = None


class InterviewIn(BaseModel):
    kind: Literal["dsa", "behavioral", "mixed"] = "mixed"


def speak(text: str) -> str | None:
    """Return base64 MP3 for the text, or None if TTS fails."""
    try:
        audio = client.audio.speech.create(
            model=TTS_MODEL, voice=TTS_VOICE, input=text, response_format="mp3"
        )
        return base64.b64encode(audio.content).decode()
    except Exception as e:
        print(f"[tts] failed: {e}")
        return None


SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
tts_pool = ThreadPoolExecutor(max_workers=4)


def stream_reply(deltas, transcript: str | None = None, on_done=None) -> StreamingResponse:
    """Stream a turn as NDJSON events: `transcript`, then `delta` text chunks as
    the model writes, and `audio` (base64 MP3) per sentence, in order. Each
    sentence is sent to TTS as soon as it is complete, so speech starts early."""

    def event(**kw) -> str:
        return json.dumps(kw) + "\n"

    def gen():
        if transcript is not None:
            yield event(type="transcript", text=transcript)
        pending = deque()  # TTS futures, in sentence order
        buf = ""

        def ready_audio(block: bool):
            while pending and (block or pending[0].done()):
                audio = pending.popleft().result()
                if audio:
                    yield event(type="audio", audio=audio)

        try:
            for delta in deltas:
                yield event(type="delta", text=delta)
                buf += delta
                *sentences, buf = SENTENCE_END.split(buf)
                pending.extend(tts_pool.submit(speak, s) for s in sentences if s.strip())
                yield from ready_audio(block=False)
            if buf.strip():
                pending.append(tts_pool.submit(speak, buf))
            yield from ready_audio(block=True)
            if on_done:
                on_done()
        except Exception as e:
            print(f"[stream] failed: {e}")
            yield event(type="error", message=str(e))

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@app.get("/api/health")
def health():
    return {"ok": True, "model": CHAT_MODEL}


@app.post("/api/talk")
async def talk(audio: UploadFile = File(...), context: str | None = Form(None)):
    """Full voice turn: audio -> Whisper -> agent -> TTS. `context` is the code
    editor state as a JSON string (multipart can't nest objects)."""
    data = await audio.read()
    if len(data) < 1000:
        raise HTTPException(400, "Recording too short")
    try:
        tr = client.audio.transcriptions.create(
            model=STT_MODEL,
            file=(audio.filename or "audio.webm", data, audio.content_type or "audio/webm"),
        )
    except Exception as e:
        raise HTTPException(502, f"Transcription failed: {e}")
    text = (tr.text or "").strip()
    if not text:
        return stream_reply(iter(()), transcript="")
    ctx = json.loads(context) if context else None
    return stream_reply(agent.respond_stream(text, context=ctx), transcript=text)


@app.post("/api/chat")
def chat(body: TextIn):
    """Typed turn (fallback when you can't talk)."""
    return stream_reply(agent.respond_stream(body.text, context=body.context), transcript=body.text)


@app.get("/api/checkin")
def checkin_status():
    return {"due": memory.checkin_due()}


@app.post("/api/checkin")
def checkin():
    return stream_reply(
        agent.respond_stream(instruction=CHECKIN_INSTRUCTION.format(name=USER_NAME)),
        on_done=memory.mark_checkin,
    )


@app.get("/api/goals")
def goals():
    return memory.goals_summary()


@app.get("/api/interview")
def interview_status():
    """Active mock interview (or null) and per-topic scores, weakest first."""
    return {"active": memory.active_interview(), "topics": memory.topic_stats()}


@app.post("/api/interview/start")
def interview_start(body: InterviewIn):
    memory.start_interview(body.kind)
    return stream_reply(agent.respond_stream(instruction=INTERVIEW_START.format(kind=body.kind)))


@app.post("/api/interview/end")
def interview_end():
    if not memory.active_interview():
        raise HTTPException(400, "No interview in progress")
    # The agent calls end_interview itself; close it anyway if the model forgot.
    return stream_reply(
        agent.respond_stream(instruction=INTERVIEW_END),
        on_done=lambda: memory.end_interview("Ended by user."),
    )


RUN_TIMEOUT = 10  # seconds
MAX_OUTPUT = 20_000  # characters per stream


def _clip(text) -> str:
    if isinstance(text, bytes):
        text = text.decode(errors="replace")
    text = text or ""
    return text if len(text) <= MAX_OUTPUT else text[:MAX_OUTPUT] + "\n... (output truncated)"


@app.post("/api/run")
def run_code(body: RunIn):
    """Run a Python script with the backend's interpreter. This executes arbitrary
    code on this machine, which is fine for a local app but never expose it publicly."""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "main.py")
        with open(path, "w") as f:
            f.write(body.code)
        started = time.perf_counter()
        try:
            proc = subprocess.run(
                [sys.executable, "-u", path],
                input=body.stdin,
                capture_output=True,
                text=True,
                timeout=RUN_TIMEOUT,
                cwd=tmp,
            )
            stdout, stderr, exit_code, timed_out = proc.stdout, proc.stderr, proc.returncode, False
        except subprocess.TimeoutExpired as e:
            stdout, stderr, exit_code, timed_out = e.stdout, e.stderr, None, True
        ms = round((time.perf_counter() - started) * 1000)
    stderr = _clip(stderr).replace(path, "main.py")
    if timed_out:
        stderr += f"\nTimed out after {RUN_TIMEOUT}s (infinite loop?)"
    return {
        "stdout": _clip(stdout),
        "stderr": stderr,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "ms": ms,
    }


@app.get("/api/problems")
def problems():
    return {
        "problems": memory.list_problems(),
        "stats": memory.problem_stats(),
        "due": memory.due_reviews(),
    }


@app.post("/api/problems")
def save_problem(body: ProblemIn):
    try:
        return memory.save_problem(body.model_dump(exclude={"id"}), problem_id=body.id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "A problem with that title already exists")


@app.delete("/api/problems/{problem_id}")
def delete_problem(problem_id: int):
    memory.delete_problem(problem_id)
    return {"ok": True}


@app.post("/api/realtime/session")
def realtime_session(body: RealtimeIn):
    """Mint a short-lived client secret so the browser can open a WebRTC call directly
    to OpenAI. The API key never leaves the backend."""
    started = time.time()
    session = {
        "type": "realtime",
        "model": REALTIME_MODEL,
        "instructions": agent.realtime_instructions(None, body.context, started),
        "tools": REALTIME_TOOLS,
        "tool_choice": "auto",
        "audio": {
            "input": {
                "transcription": {"model": REALTIME_STT_MODEL},
                "noise_reduction": {"type": REALTIME_NOISE},
                "turn_detection": {
                    "type": "semantic_vad",
                    "eagerness": REALTIME_EAGERNESS,
                    "create_response": True,
                    "interrupt_response": True,
                },
            },
            "output": {"voice": REALTIME_VOICE},
        },
    }
    res = httpx.post(
        "https://api.openai.com/v1/realtime/client_secrets",
        headers={"Authorization": f"Bearer {client.api_key}"},
        json={"session": session},
        timeout=20,
    )
    if res.status_code >= 400:
        raise HTTPException(502, f"Realtime session failed: {res.text}")
    checkin = None
    if memory.checkin_due():
        memory.mark_checkin()
        checkin = CHECKIN_INSTRUCTION.format(name=USER_NAME)
    return {
        "client_secret": res.json()["value"],
        "model": REALTIME_MODEL,
        "call_started": started,
        "checkin": checkin,
    }


@app.post("/api/realtime/instructions")
def realtime_instructions(body: RealtimeIn):
    """Fresh instructions (memories, goals, code context) to push via session.update."""
    return {"instructions": agent.realtime_instructions(body.query, body.context, body.call_started)}


@app.post("/api/realtime/tool")
def realtime_tool(body: RealtimeToolIn):
    """Run a tool the Realtime model called. Returns updated instructions too, since tools
    can switch modes (e.g. start_interview)."""
    try:
        args = json.loads(body.arguments or "{}")
    except json.JSONDecodeError:
        args = {}
    output = agent.run_tool(body.name, args, body.context)
    return {
        "output": output,
        "instructions": agent.realtime_instructions(body.query, body.context, body.call_started),
    }


@app.post("/api/realtime/log")
def realtime_log(body: LogIn):
    """Save a call transcript line so history and memory stay continuous across modes."""
    if body.text.strip():
        memory.add_message(body.role, body.text.strip())
    return {"ok": True}


@app.get("/api/history")
def history(n: int = 20):
    return memory.recent_messages(n)
