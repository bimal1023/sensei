"""Sensei's brain: an OpenAI tool-calling agent with memory and goal tracking."""

import json
import os
from datetime import date

from memory import Memory

USER_NAME = os.getenv("SENSEI_USER_NAME", "friend")

SYSTEM_PROMPT = """You are Sensei, a personal mentor and accountability coach for {name}.
You are speaking out loud through a 3D avatar, so talk like a real mentor in a voice call:
1-3 short sentences, warm but direct, no markdown, no lists, no emojis. Ask one question at a time.

How you mentor:
- Hold {name} accountable: compare what they committed to with what they actually did.
- Celebrate real wins specifically. Name slips plainly, without guilt-tripping, and ask what got in the way.
- End most turns with one concrete, small next step.
- Push toward growth: career, skills, habits, health, focus. Challenge excuses kindly.

Tools:
- If {name} asks for a mock interview or interview practice, call `start_interview`.
- When {name} shares a durable fact about themselves (a goal, value, constraint, weakness, win), call `remember`.
- When they commit to a goal, call `add_goal`. When they report doing work toward one, call `log_progress`.
- Never invent progress. Use the goal data below as ground truth.

Today is {today}.

What you remember that may be relevant:
{memories}

Active goals (last 7 days of progress):
{goals}

LeetCode: {leetcode}
Problems due for review (spaced repetition; suggest one when it fits):
{reviews}
"""

CHECKIN_INSTRUCTION = (
    "Start today's daily check-in now. Greet {name} briefly, then, based on the goals "
    "and recent progress above, ask about the single most important commitment. If there "
    "are no goals yet, ask what they most want to grow in over the next 90 days."
)

DSA_TOPICS = [
    "arrays & hashing", "two pointers", "sliding window", "stack", "binary search",
    "linked list", "trees", "tries", "heap", "backtracking", "graphs",
    "dynamic programming", "greedy", "intervals", "bit manipulation", "math",
]
BEHAVIORAL_TOPICS = [
    "teamwork", "conflict", "failure", "leadership", "ownership", "ambiguity",
    "impact", "learning", "motivation",
]

INTERVIEW_PROMPT = """You are Sensei, running a live mock {kind} interview with {name} over a voice call.
You invent every question yourself. Never read from a list, and never repeat a recent question.

Voice rules: no markdown, no code, no lists, no emojis. Describe any example input and output
in plain words. Keep each turn to about 4 sentences.

How to run it:
- Ask one question at a time. {kind_rules}
- Roughly half your questions should target {name}'s weak topics below. Mix in others too.
- After {name} answers, call `score_answer` exactly once for that question, then give one
  specific strength, one specific improvement, and move to the next question.
- If they are stuck, give one small hint before scoring. Don't reveal the full solution
  unless they ask.
- Score honestly: clarity is how structured and understandable the spoken answer was;
  correctness is whether the approach, complexity, or story actually answers the question.
  1 = poor, 3 = acceptable, 5 = excellent.
- When {name} wants to stop, or after about 5 questions, call `end_interview` with a short
  summary, then say their weakest area and one thing to practice.

DSA topics: {dsa_topics}
Behavioral topics: {behavioral_topics}

Weak topics so far (weakest first, score out of 5):
{weak}

Recent questions (do not repeat):
{recent}

Questions answered this interview: {answered}
"""

KIND_RULES = {
    "dsa": "Make up a LeetCode-medium style problem that can be explained out loud. Ask for "
    "their approach, time and space complexity, and edge cases.",
    "behavioral": "Ask a behavioral question and expect a STAR-style story (situation, task, "
    "action, result). Probe for specifics and measurable results.",
    "mixed": "Alternate between DSA problems (approach, complexity, edge cases) and behavioral "
    "questions (STAR-style stories).",
}

INTERVIEW_START = "Start the {kind} mock interview now: one short line of setup, then the first question."
INTERVIEW_END = (
    "The interview is ending now. Call `end_interview` with a short summary, then give a brief "
    "spoken wrap-up: their weakest area and one thing to practice before next time."
)

CODE_CONTEXT = """{name} has the code editor open. This is its live state right now:

Problem: {title} ({difficulty}, topic: {topic}, status: {status}, id: {id})
Description:
{description}

Code:
{code}

Last run:
{run}

Tutor rules while coding:
- Guide, don't solve. Ask a question or give the smallest useful hint first. Only give a full
  solution if {name} explicitly asks for it.
- Refer to their actual code: specific variable names, lines, and the error or output above.
- You are speaking aloud, so describe code in words. If a snippet is truly needed, keep it to
  one short line.
- Name the underlying pattern and the time and space complexity, so the lesson transfers.
- When their solution works, ask how confident they feel from 1 to 5, then call `log_problem`
  with status solved and that confidence. If they stop midway, log it as attempted with a note
  on where they got stuck.
"""

MAX_CODE_CHARS = 8000


def format_code_context(ctx: dict) -> str:
    p = ctx.get("problem") or {}
    run = ctx.get("run")
    if run:
        run_text = (
            f"exit code {run.get('exit_code')}, {run.get('ms')} ms\n"
            f"stdout:\n{(run.get('stdout') or '')[-2000:] or '(empty)'}\n"
            f"stderr:\n{(run.get('stderr') or '')[-2000:] or '(empty)'}"
        )
    else:
        run_text = "(not run yet)"
    return CODE_CONTEXT.format(
        name=USER_NAME,
        title=p.get("title") or "(untitled)",
        difficulty=p.get("difficulty") or "?",
        topic=p.get("topic") or "?",
        status=p.get("status") or "todo",
        id=p.get("id") or "unsaved",
        description=(p.get("description") or "(none pasted)")[:4000],
        code=(ctx.get("code") or "(empty)")[:MAX_CODE_CHARS],
        run=run_text,
    )


REALTIME_RULES = """You are in a live voice call. Talk the way people do on a call: short,
natural sentences. If {name} interrupts you, stop and respond to what they said. If they pause
mid-thought, let them finish. Speak English unless {name} switches language."""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "remember",
            "description": "Save a durable fact about the user to long-term memory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The fact, in third person."},
                    "kind": {
                        "type": "string",
                        "enum": ["fact", "value", "struggle", "win", "preference"],
                    },
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_goal",
            "description": "Create a new goal the user commits to.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "target": {"type": "string", "description": "e.g. '5 LeetCode mediums'"},
                    "cadence": {"type": "string", "enum": ["daily", "weekly", "monthly", "once"]},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "log_progress",
            "description": "Log progress the user reports toward an existing goal.",
            "parameters": {
                "type": "object",
                "properties": {
                    "goal_id": {"type": "integer"},
                    "note": {"type": "string"},
                    "amount": {"type": "number", "description": "Units done, default 1."},
                },
                "required": ["goal_id", "note"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_goal_status",
            "description": "Mark a goal completed or dropped.",
            "parameters": {
                "type": "object",
                "properties": {
                    "goal_id": {"type": "integer"},
                    "status": {"type": "string", "enum": ["completed", "dropped", "active"]},
                },
                "required": ["goal_id", "status"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "start_interview",
            "description": "Start a mock interview session.",
            "parameters": {
                "type": "object",
                "properties": {"kind": {"type": "string", "enum": ["dsa", "behavioral", "mixed"]}},
                "required": ["kind"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "score_answer",
            "description": "Record the score for the user's answer to the current interview question.",
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["dsa", "behavioral"]},
                    "topic": {"type": "string", "enum": DSA_TOPICS + BEHAVIORAL_TOPICS},
                    "question": {"type": "string", "description": "The question, in one sentence."},
                    "clarity": {"type": "integer", "minimum": 1, "maximum": 5},
                    "correctness": {"type": "integer", "minimum": 1, "maximum": 5},
                    "feedback": {"type": "string", "description": "One-line note for review."},
                },
                "required": ["kind", "topic", "question", "clarity", "correctness", "feedback"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "end_interview",
            "description": "End the current mock interview.",
            "parameters": {
                "type": "object",
                "properties": {"summary": {"type": "string"}},
                "required": ["summary"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "log_problem",
            "description": "Create or update a LeetCode problem in the user's tracker. Omit "
            "title to update the problem currently open in the editor.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "difficulty": {"type": "string", "enum": ["easy", "medium", "hard"]},
                    "topic": {"type": "string", "enum": DSA_TOPICS},
                    "status": {"type": "string", "enum": ["todo", "attempted", "solved"]},
                    "confidence": {"type": "integer", "minimum": 1, "maximum": 5},
                    "notes": {"type": "string", "description": "Key insight or where they got stuck."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "recall",
            "description": "Search long-term memory for something specific.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
]


# The Realtime API takes a flat function schema instead of Chat Completions' nested one.
REALTIME_TOOLS = [{"type": "function", **t["function"]} for t in TOOLS]


class Agent:
    def __init__(self, client, model: str, memory: Memory):
        self.client = client
        self.model = model
        self.memory = memory

    def _interview_system(self, interview: dict) -> str:
        weak = [t for t in self.memory.topic_stats() if t["score"] < 4][:6]
        recent = self.memory.recent_questions()
        return INTERVIEW_PROMPT.format(
            name=USER_NAME,
            kind=interview["kind"],
            kind_rules=KIND_RULES[interview["kind"]],
            dsa_topics=", ".join(DSA_TOPICS),
            behavioral_topics=", ".join(BEHAVIORAL_TOPICS),
            weak="\n".join(f"- {t['topic']} ({t['kind']}): {t['score']}" for t in weak)
            or "(no data yet)",
            recent="\n".join(f"- {q}" for q in recent) or "(none)",
            answered=interview["answered"],
        )

    def _system(self, query: str) -> str:
        memories = self.memory.recall(query) or ["(nothing yet)"]
        goals = self.memory.goals_summary()
        return SYSTEM_PROMPT.format(
            name=USER_NAME,
            today=date.today().strftime("%A, %B %d, %Y"),
            memories="\n".join(f"- {m}" for m in memories),
            goals=json.dumps(goals, indent=1) if goals else "(no goals yet)",
            leetcode=json.dumps(self.memory.problem_stats()),
            reviews="\n".join(
                f"- {r['title']} ({r['difficulty']}, {r['topic']}, confidence {r['confidence']})"
                for r in self.memory.due_reviews()
            )
            or "(none due)",
        )

    def _log_problem(self, args: dict, context: dict | None) -> str:
        open_problem = (context or {}).get("problem") or {}
        title = args.get("title")
        same = not title or title.strip().lower() == (open_problem.get("title") or "").strip().lower()
        fields = dict(args)
        problem_id = None
        if same and context:  # the problem in the editor: save its code and description too
            problem_id = open_problem.get("id")
            fields["title"] = title or open_problem.get("title")
            fields["code"] = context.get("code")
            fields.setdefault("description", open_problem.get("description"))
            fields.setdefault("difficulty", open_problem.get("difficulty"))
            fields.setdefault("topic", open_problem.get("topic"))
        p = self.memory.save_problem(fields, problem_id=problem_id, new_attempt=True)
        return f"logged '{p['title']}' as {p['status']} (attempt {p['attempts']})"

    def run_tool(self, name: str, args: dict, context: dict | None = None) -> str:
        m = self.memory
        try:
            if name == "log_problem":
                return self._log_problem(args, context)
            if name == "remember":
                m.remember(args["text"], args.get("kind", "fact"))
                return "saved"
            if name == "add_goal":
                gid = m.add_goal(args["title"], args.get("target", ""), args.get("cadence", "weekly"))
                return f"goal created with id {gid}"
            if name == "log_progress":
                m.log_progress(int(args["goal_id"]), args["note"], float(args.get("amount", 1)))
                return "progress logged"
            if name == "set_goal_status":
                m.set_goal_status(int(args["goal_id"]), args["status"])
                return "status updated"
            if name == "start_interview":
                kind = args.get("kind", "mixed")
                m.start_interview(kind if kind in KIND_RULES else "mixed")
                return "interview started; ask the first question now"
            if name == "score_answer":
                m.score_answer(
                    args["kind"], args["topic"], args["question"],
                    args["clarity"], args["correctness"], args.get("feedback", ""),
                )
                return "score saved"
            if name == "end_interview":
                ended = m.end_interview(args.get("summary", ""))
                return "interview ended" if ended else "no interview was active"
            if name == "recall":
                return json.dumps(m.recall(args["query"], k=8))
        except Exception as e:
            return f"tool error: {e}"
        return f"unknown tool {name}"

    def _system_for(self, user_text: str | None) -> dict:
        """Interviewer prompt while a mock interview is active, mentor prompt otherwise."""
        interview = self.memory.active_interview()
        if interview:
            content = self._interview_system(interview)
        else:
            content = self._system(user_text or "daily check-in goals progress")
        return {"role": "system", "content": content}

    def _messages(
        self, user_text: str | None, instruction: str | None, context: dict | None
    ) -> list[dict]:
        messages = [self._system_for(user_text)]
        messages += self.memory.recent_messages(12)
        if context:
            messages.append({"role": "system", "content": format_code_context(context)})
        if instruction:
            messages.append({"role": "system", "content": instruction})
        return messages

    def realtime_instructions(
        self, query: str | None, context: dict | None, call_started: float
    ) -> str:
        """Session instructions for a live Realtime call: the current mode's prompt, the
        call rules, live code context, and the conversation from before the call (the
        Realtime session holds the in-call conversation itself)."""
        parts = [self._system_for(query)["content"], REALTIME_RULES.format(name=USER_NAME)]
        if context:
            parts.append(format_code_context(context))
        history = self.memory.recent_messages(12, before=call_started)
        if history:
            parts.append(
                "Conversation before this call, for continuity:\n"
                + "\n".join(f"{m['role']}: {m['content']}" for m in history)
            )
        return "\n\n".join(parts)

    def respond_stream(
        self,
        user_text: str | None = None,
        instruction: str | None = None,
        context: dict | None = None,
    ):
        """Yield the reply as text deltas while it is generated, running any
        tool calls in between. The full reply is saved to history at the end.
        `context` is the live code editor state, when the code panel is open."""
        if user_text:
            self.memory.add_message("user", user_text)
        messages = self._messages(user_text, instruction, context)

        reply = ""
        try:
            for _ in range(5):  # tool-call loop
                stream = self.client.chat.completions.create(
                    model=self.model, messages=messages, tools=TOOLS, temperature=0.7, stream=True
                )
                content = ""
                calls: dict[int, dict] = {}
                for chunk in stream:
                    if not chunk.choices:
                        continue
                    delta = chunk.choices[0].delta
                    if delta.content:
                        content += delta.content
                        yield delta.content
                    for tc in delta.tool_calls or []:  # tool calls arrive in fragments
                        c = calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                        c["id"] = tc.id or c["id"]
                        if tc.function:
                            c["name"] += tc.function.name or ""
                            c["arguments"] += tc.function.arguments or ""
                reply += content
                if not calls:
                    break
                messages.append(
                    {
                        "role": "assistant",
                        "content": content or None,
                        "tool_calls": [
                            {
                                "id": c["id"],
                                "type": "function",
                                "function": {"name": c["name"], "arguments": c["arguments"]},
                            }
                            for c in calls.values()
                        ],
                    }
                )
                for c in calls.values():
                    try:
                        args = json.loads(c["arguments"] or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": c["id"],
                            "content": self.run_tool(c["name"], args, context),
                        }
                    )
                # tools may start/end an interview or save a score, so refresh the prompt
                messages[0] = self._system_for(user_text)
            if not reply.strip():
                reply = "Got it. What's the next small step you'll take?"
                yield reply
        finally:  # also runs if the client disconnects mid-reply
            if reply.strip():
                self.memory.add_message("assistant", reply.strip())
