"""Sensei's memory: SQLite for goals, progress, chat history, and long-term
facts (with OpenAI embeddings for semantic recall)."""

import json
import os
import sqlite3
import time
from datetime import date, datetime

import numpy as np

DB_PATH = os.getenv("SENSEI_DB", "sensei.db")

# Days until a solved problem is due for review, by confidence (1-5).
REVIEW_DAYS = {1: 1, 2: 3, 3: 7, 4: 14, 5: 30}
PROBLEM_FIELDS = ("title", "difficulty", "topic", "status", "description", "code", "notes", "confidence")


class Memory:
    def __init__(self, client, embed_model: str):
        self.client = client
        self.embed_model = embed_model
        self.conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY, text TEXT NOT NULL, kind TEXT,
                embedding TEXT, created REAL);
            CREATE TABLE IF NOT EXISTS goals (
                id INTEGER PRIMARY KEY, title TEXT NOT NULL, target TEXT,
                cadence TEXT, status TEXT DEFAULT 'active', created REAL);
            CREATE TABLE IF NOT EXISTS progress (
                id INTEGER PRIMARY KEY, goal_id INTEGER, note TEXT,
                amount REAL, created REAL);
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY, role TEXT, content TEXT, created REAL);
            CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS interviews (
                id INTEGER PRIMARY KEY, kind TEXT, started REAL, ended REAL, summary TEXT);
            CREATE TABLE IF NOT EXISTS attempts (
                id INTEGER PRIMARY KEY, interview_id INTEGER, kind TEXT, topic TEXT,
                question TEXT, clarity INTEGER, correctness INTEGER, feedback TEXT,
                created REAL);
            CREATE TABLE IF NOT EXISTS problems (
                id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, difficulty TEXT,
                topic TEXT, status TEXT DEFAULT 'todo', description TEXT, code TEXT,
                notes TEXT, confidence INTEGER, attempts INTEGER DEFAULT 0,
                created REAL, updated REAL, next_review REAL);
            """
        )
        self.conn.commit()

    # ---------- embeddings ----------
    def _embed(self, text: str):
        try:
            res = self.client.embeddings.create(model=self.embed_model, input=text)
            return res.data[0].embedding
        except Exception as e:  # memory must never crash the conversation
            print(f"[memory] embedding failed: {e}")
            return None

    # ---------- long-term facts ----------
    def remember(self, text: str, kind: str = "fact") -> int:
        emb = self._embed(text)
        cur = self.conn.execute(
            "INSERT INTO memories(text, kind, embedding, created) VALUES (?,?,?,?)",
            (text, kind, json.dumps(emb) if emb else None, time.time()),
        )
        self.conn.commit()
        return cur.lastrowid

    def recall(self, query: str, k: int = 5) -> list[str]:
        rows = self.conn.execute("SELECT text, kind, embedding FROM memories").fetchall()
        if not rows:
            return []
        with_emb = [r for r in rows if r["embedding"]]
        q = self._embed(query) if with_emb else None
        if q is None:  # fall back to most recent facts
            return [f"[{r['kind']}] {r['text']}" for r in rows[-k:]]
        q = np.array(q)
        mat = np.array([json.loads(r["embedding"]) for r in with_emb])
        sims = mat @ q / (np.linalg.norm(mat, axis=1) * np.linalg.norm(q) + 1e-9)
        top = np.argsort(-sims)[:k]
        return [f"[{with_emb[i]['kind']}] {with_emb[i]['text']}" for i in top if sims[i] > 0.2]

    # ---------- goals ----------
    def add_goal(self, title: str, target: str = "", cadence: str = "weekly") -> int:
        cur = self.conn.execute(
            "INSERT INTO goals(title, target, cadence, created) VALUES (?,?,?,?)",
            (title, target, cadence, time.time()),
        )
        self.conn.commit()
        return cur.lastrowid

    def set_goal_status(self, goal_id: int, status: str) -> None:
        self.conn.execute("UPDATE goals SET status=? WHERE id=?", (status, goal_id))
        self.conn.commit()

    def log_progress(self, goal_id: int, note: str, amount: float = 1.0) -> None:
        self.conn.execute(
            "INSERT INTO progress(goal_id, note, amount, created) VALUES (?,?,?,?)",
            (goal_id, note, amount, time.time()),
        )
        self.conn.commit()

    def goals_summary(self) -> list[dict]:
        week_ago = time.time() - 7 * 86400
        goals = self.conn.execute(
            "SELECT * FROM goals WHERE status='active' ORDER BY id"
        ).fetchall()
        out = []
        for g in goals:
            p = self.conn.execute(
                "SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n "
                "FROM progress WHERE goal_id=? AND created>=?",
                (g["id"], week_ago),
            ).fetchone()
            last = self.conn.execute(
                "SELECT note, created FROM progress WHERE goal_id=? "
                "ORDER BY created DESC LIMIT 1",
                (g["id"],),
            ).fetchone()
            out.append(
                {
                    "id": g["id"],
                    "title": g["title"],
                    "target": g["target"],
                    "cadence": g["cadence"],
                    "done_last_7_days": p["total"],
                    "entries_last_7_days": p["n"],
                    "last_update": (
                        f"{last['note']} ({datetime.fromtimestamp(last['created']):%b %d})"
                        if last
                        else None
                    ),
                }
            )
        return out

    # ---------- conversation history ----------
    def add_message(self, role: str, content: str) -> None:
        self.conn.execute(
            "INSERT INTO messages(role, content, created) VALUES (?,?,?)",
            (role, content, time.time()),
        )
        self.conn.commit()

    def recent_messages(self, n: int = 12, before: float | None = None) -> list[dict]:
        rows = self.conn.execute(
            "SELECT role, content FROM messages WHERE created < ? ORDER BY id DESC LIMIT ?",
            (before if before is not None else float("inf"), n),
        ).fetchall()
        return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]

    # ---------- daily check-in ----------
    def checkin_due(self) -> bool:
        row = self.conn.execute("SELECT value FROM kv WHERE key='last_checkin'").fetchone()
        return row is None or row["value"] != date.today().isoformat()

    def mark_checkin(self) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO kv(key, value) VALUES ('last_checkin', ?)",
            (date.today().isoformat(),),
        )
        self.conn.commit()

    # ---------- mock interviews ----------
    def active_interview(self) -> dict | None:
        row = self.conn.execute(
            "SELECT i.id, i.kind, i.started, COUNT(a.id) AS answered FROM interviews i "
            "LEFT JOIN attempts a ON a.interview_id = i.id "
            "WHERE i.ended IS NULL GROUP BY i.id ORDER BY i.id DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None

    def start_interview(self, kind: str) -> int:
        active = self.active_interview()
        if active:
            self.end_interview("Replaced by a new interview.")
        cur = self.conn.execute(
            "INSERT INTO interviews(kind, started) VALUES (?,?)", (kind, time.time())
        )
        self.conn.commit()
        return cur.lastrowid

    def end_interview(self, summary: str = "") -> dict | None:
        active = self.active_interview()
        if not active:
            return None
        self.conn.execute(
            "UPDATE interviews SET ended=?, summary=? WHERE id=?",
            (time.time(), summary, active["id"]),
        )
        self.conn.commit()
        return active

    def score_answer(
        self, kind: str, topic: str, question: str, clarity: int, correctness: int, feedback: str
    ) -> None:
        active = self.active_interview()
        self.conn.execute(
            "INSERT INTO attempts(interview_id, kind, topic, question, clarity, correctness, "
            "feedback, created) VALUES (?,?,?,?,?,?,?,?)",
            (
                active["id"] if active else None,
                kind,
                topic.strip().lower(),
                question,
                max(1, min(5, int(clarity))),
                max(1, min(5, int(correctness))),
                feedback,
                time.time(),
            ),
        )
        self.conn.commit()

    def topic_stats(self) -> list[dict]:
        """Average scores per topic, weakest first."""
        rows = self.conn.execute(
            "SELECT kind, topic, COUNT(*) AS attempts, AVG(clarity) AS clarity, "
            "AVG(correctness) AS correctness, MAX(created) AS last "
            "FROM attempts GROUP BY kind, topic "
            "ORDER BY (AVG(clarity) + AVG(correctness)) / 2.0 ASC, attempts DESC"
        ).fetchall()
        return [
            {
                "kind": r["kind"],
                "topic": r["topic"],
                "attempts": r["attempts"],
                "clarity": round(r["clarity"], 1),
                "correctness": round(r["correctness"], 1),
                "score": round((r["clarity"] + r["correctness"]) / 2, 1),
            }
            for r in rows
        ]

    def recent_questions(self, n: int = 15) -> list[str]:
        rows = self.conn.execute(
            "SELECT question FROM attempts ORDER BY id DESC LIMIT ?", (n,)
        ).fetchall()
        return [r["question"] for r in rows]

    # ---------- LeetCode problems ----------
    def save_problem(
        self, fields: dict, problem_id: int | None = None, new_attempt: bool = False
    ) -> dict:
        """Create or update a problem, matched by id, else by title (case-insensitive).
        Attempts and the review date only move on a real attempt: a status change,
        a confidence change, or new_attempt=True."""
        data = {k: v for k, v in fields.items() if k in PROBLEM_FIELDS and v is not None}
        if "title" in data:
            data["title"] = data["title"].strip()
        if data.get("confidence") is not None:
            data["confidence"] = max(1, min(5, int(data["confidence"])))
        row = None
        if problem_id is not None:
            row = self.conn.execute("SELECT * FROM problems WHERE id=?", (problem_id,)).fetchone()
        elif data.get("title"):
            row = self.conn.execute(
                "SELECT * FROM problems WHERE lower(title)=lower(?)", (data["title"],)
            ).fetchone()
        now = time.time()
        if row is None:
            if not data.get("title"):
                raise ValueError("title is required for a new problem")
            cur = self.conn.execute(
                "INSERT INTO problems(title, created, updated) VALUES (?,?,?)",
                (data["title"], now, now),
            )
            problem_id = cur.lastrowid
            old = {}
        else:
            if problem_id is None:  # matched by title: keep the stored spelling
                data.pop("title", None)
            problem_id = row["id"]
            old = dict(row)
        if data:
            cols = ", ".join(f"{k}=?" for k in data)
            self.conn.execute(
                f"UPDATE problems SET {cols}, updated=? WHERE id=?",
                (*data.values(), now, problem_id),
            )
        status_changed = data.get("status") in ("attempted", "solved") and data.get(
            "status"
        ) != old.get("status")
        confidence_changed = "confidence" in data and data["confidence"] != old.get("confidence")
        attempted = new_attempt or status_changed or confidence_changed
        if attempted:
            self.conn.execute("UPDATE problems SET attempts=attempts+1 WHERE id=?", (problem_id,))
        p = self.get_problem(problem_id)
        if attempted and p["status"] == "solved":
            days = REVIEW_DAYS.get(p["confidence"] or 3, 7)
            self.conn.execute(
                "UPDATE problems SET next_review=? WHERE id=?", (now + days * 86400, problem_id)
            )
        self.conn.commit()
        return self.get_problem(problem_id)

    def get_problem(self, problem_id: int) -> dict | None:
        row = self.conn.execute("SELECT * FROM problems WHERE id=?", (problem_id,)).fetchone()
        return dict(row) if row else None

    def list_problems(self) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM problems ORDER BY updated DESC").fetchall()
        return [dict(r) for r in rows]

    def delete_problem(self, problem_id: int) -> None:
        self.conn.execute("DELETE FROM problems WHERE id=?", (problem_id,))
        self.conn.commit()

    def problem_stats(self) -> dict:
        rows = self.conn.execute(
            "SELECT difficulty, COUNT(*) AS n FROM problems WHERE status='solved' GROUP BY difficulty"
        ).fetchall()
        by_diff = {(r["difficulty"] or "unknown"): r["n"] for r in rows}
        return {
            "solved": sum(by_diff.values()),
            "by_difficulty": by_diff,
            "attempted": self.conn.execute(
                "SELECT COUNT(*) FROM problems WHERE status='attempted'"
            ).fetchone()[0],
        }

    def due_reviews(self, limit: int = 5) -> list[dict]:
        rows = self.conn.execute(
            "SELECT id, title, difficulty, topic, confidence FROM problems "
            "WHERE status='solved' AND next_review <= ? ORDER BY next_review LIMIT ?",
            (time.time(), limit),
        ).fetchall()
        return [dict(r) for r in rows]
