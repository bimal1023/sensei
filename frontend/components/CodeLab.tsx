"use client";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import {
  api,
  CodeContext,
  Difficulty,
  DSA_TOPICS,
  Problem,
  ProblemStatus,
  RunResult,
} from "@/lib/api";

const TEMPLATE = `class Solution:
    def solve(self, nums: list[int]) -> int:
        pass


# Call your solution so Run prints something:
print(Solution().solve([1, 2, 3]))
`;

type Draft = {
  title: string;
  difficulty: Difficulty | "";
  topic: string;
  status: ProblemStatus;
  confidence: number | "";
  description: string;
  code: string;
};

const EMPTY: Draft = {
  title: "",
  difficulty: "",
  topic: "",
  status: "todo",
  confidence: "",
  description: "",
  code: TEMPLATE,
};

const STATUS_MARK: Record<ProblemStatus, string> = { todo: "○", attempted: "◐", solved: "●" };

function toDraft(p: Problem): Draft {
  return {
    title: p.title,
    difficulty: p.difficulty ?? "",
    topic: p.topic ?? "",
    status: p.status,
    confidence: p.confidence ?? "",
    description: p.description ?? "",
    code: p.code ?? TEMPLATE,
  };
}

type Props = {
  problems: Problem[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onSaved: () => void;
  /** Called whenever the editor state changes, so voice/chat turns can include it. */
  onContext: (ctx: CodeContext) => void;
  /** Send a message to Sensei (with the code context attached). */
  ask: (text: string) => void;
  busy: boolean;
};

export default function CodeLab({ problems, selectedId, onSelect, onSaved, onContext, ask, busy }: Props) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [run, setRun] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const current = problems.find((p) => p.id === selectedId) ?? null;

  // Load a problem when the selection changes.
  useEffect(() => {
    setDraft(current ? toDraft(current) : EMPTY);
    setRun(null);
    setConfirmDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Sensei can update status/confidence via its log_problem tool; pull those in
  // without touching the code being edited.
  useEffect(() => {
    if (!current) return;
    setDraft((d) => ({
      ...d,
      status: current.status,
      confidence: current.confidence ?? "",
    }));
  }, [current?.status, current?.confidence]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onContext({
      code: draft.code,
      run,
      problem: {
        id: selectedId ?? undefined,
        title: draft.title || undefined,
        difficulty: draft.difficulty || null,
        topic: draft.topic || null,
        status: draft.status,
        description: draft.description || null,
      },
    });
  }, [draft, run, selectedId, onContext]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const flash = (msg: string) => {
    setNote(msg);
    setTimeout(() => setNote(null), 2500);
  };

  const save = async () => {
    if (!draft.title.trim()) return flash("Add a title first");
    try {
      const p = await api.saveProblem({
        id: selectedId ?? undefined,
        title: draft.title.trim(),
        difficulty: draft.difficulty || null,
        topic: draft.topic || null,
        status: draft.status,
        confidence: draft.confidence === "" ? null : draft.confidence,
        description: draft.description,
        code: draft.code,
      });
      onSelect(p.id);
      onSaved();
      flash("Saved");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Save failed");
    }
  };

  const execute = async () => {
    setRunning(true);
    try {
      setRun(await api.run(draft.code));
    } catch (e) {
      setRun({ stdout: "", stderr: String(e), exit_code: null, timed_out: false, ms: 0 });
    } finally {
      setRunning(false);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    if (!confirmDelete) return setConfirmDelete(true);
    await api.deleteProblem(selectedId);
    onSelect(null);
    onSaved();
  };

  // Monaco keybindings are registered once, so route them through refs to the latest handlers.
  const saveRef = useRef(save);
  const runRef = useRef(execute);
  saveRef.current = save;
  runRef.current = execute;
  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
  };

  const failed = run && (run.exit_code !== 0 || run.timed_out);

  return (
    <section className="codelab">
      <div className="cl-row">
        <select
          className="cl-pick"
          value={selectedId ?? ""}
          onChange={(e) => onSelect(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">+ New problem</option>
          {problems.map((p) => (
            <option key={p.id} value={p.id}>
              {STATUS_MARK[p.status]} {p.title}
            </option>
          ))}
        </select>
        {note && <span className="muted small">{note}</span>}
        <button className="chip" onClick={save} title="⌘S">
          Save
        </button>
        {selectedId && (
          <button className="chip danger" onClick={remove} onBlur={() => setConfirmDelete(false)}>
            {confirmDelete ? "Confirm delete" : "Delete"}
          </button>
        )}
      </div>

      <div className="cl-row cl-meta">
        <input
          className="cl-title"
          value={draft.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder="Problem title, e.g. 1. Two Sum"
        />
        <select value={draft.difficulty} onChange={(e) => set("difficulty", e.target.value as Draft["difficulty"])}>
          <option value="">Difficulty</option>
          <option value="easy">Easy</option>
          <option value="medium">Medium</option>
          <option value="hard">Hard</option>
        </select>
        <select value={draft.topic} onChange={(e) => set("topic", e.target.value)}>
          <option value="">Topic</option>
          {DSA_TOPICS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select value={draft.status} onChange={(e) => set("status", e.target.value as ProblemStatus)}>
          <option value="todo">To do</option>
          <option value="attempted">Attempted</option>
          <option value="solved">Solved</option>
        </select>
        <select
          value={draft.confidence}
          onChange={(e) => set("confidence", e.target.value ? Number(e.target.value) : "")}
          title="How confident are you? Sets the next review date."
        >
          <option value="">Confidence</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n} / 5
            </option>
          ))}
        </select>
      </div>

      <details className="cl-desc">
        <summary>Problem description</summary>
        <textarea
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="Paste the LeetCode problem statement so Sensei knows what you're solving."
          rows={5}
        />
      </details>

      <div className="cl-editor">
        <Editor
          language="python"
          theme="vs-dark"
          value={draft.code}
          onChange={(v) => set("code", v ?? "")}
          onMount={onMount}
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 4,
            padding: { top: 12 },
          }}
        />
      </div>

      <div className="cl-row">
        <button className="run" onClick={execute} disabled={running} title="⌘↵">
          {running ? "Running…" : "▶ Run"}
        </button>
        <button className="chip" disabled={busy} onClick={() => ask("Give me a small hint for this problem.")}>
          Hint
        </button>
        <button
          className="chip"
          disabled={busy}
          onClick={() => ask("Review my code: correctness, edge cases, and time and space complexity.")}
        >
          Review
        </button>
        {failed && (
          <button className="chip" disabled={busy} onClick={() => ask("Help me understand this error.")}>
            Explain error
          </button>
        )}
      </div>

      <pre className={`cl-output${failed ? " failed" : ""}`}>
        {run ? (
          <>
            {run.stdout}
            {run.stderr && <span className="stderr">{run.stderr}</span>}
            <span className="muted small">
              {"\n"}
              {run.timed_out ? "timed out" : `exit ${run.exit_code}`} · {run.ms} ms
            </span>
          </>
        ) : (
          <span className="muted">Output appears here. ⌘↵ to run, ⌘S to save.</span>
        )}
      </pre>
    </section>
  );
}
