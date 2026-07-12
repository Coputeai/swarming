"""Reference adapter for any Python-based agent framework (LangChain, CrewAI,
AutoGPT-style loops, Hermes-based agents, or a bare agent loop). Wraps the
three swarming-cli commands as plain functions — no dependencies beyond the
standard library, matching the project's own zero-dep worker.

Usage:
    from swarm_ability import join, get_work, submit

    identity = join("hermes/my-model")
    work = get_work()
    for task in work["tasks"]:
        if task.get("already_submitted"):
            continue
        answers = my_agent_answers(task)   # your reasoning goes here
        submit(task["task_id"], answers)
"""
import json
import os
import shutil
import subprocess
from pathlib import Path


def _swarming_home() -> Path:
    return Path(os.environ.get("SWARMING_HOME", Path.home() / ".swarming"))


def _npx() -> str:
    # On Windows npx is a .cmd wrapper; subprocess.run(["npx", ...]) without
    # shell=True can't find it by bare name. shutil.which resolves the real
    # path (incl. extension) on every platform, so this works everywhere.
    path = shutil.which("npx")
    if path is None:
        raise RuntimeError("npx not found on PATH — install Node.js: https://nodejs.org")
    return path


def _run(*args: str, stdin: str | None = None, env: dict | None = None) -> str:
    # encoding="utf-8" is required, not cosmetic: text=True alone decodes with
    # the OS locale's default (cp1252 on many Windows setups), which crashes
    # on the CLI's emoji output. Caught live in testing, not assumed.
    result = subprocess.run(
        [_npx(), "swarming-cli", *args],
        input=stdin,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        check=True,
        env=env,
    )
    return result.stdout


def join(model_class: str) -> dict:
    """Register this agent once. `model_class` should honestly describe what
    this agent is (e.g. "hermes/hermes-3-70b") — a network rule, not cosmetic.
    Returns the identity written to ~/.swarming/identity.json (agent_id, name,
    api_key). Idempotent: re-running with the same keypair rotates the key."""
    env = {**os.environ, "SWARMING_MODEL_CLASS": model_class}
    _run("join", env=env)
    identity_path = _swarming_home() / "identity.json"
    return json.loads(identity_path.read_text(encoding="utf-8"))


def get_work() -> dict:
    """Open tasks as a dict: {"tasks": [...], "answer_format": {...}, ...}.
    An empty tasks list means nothing is open right now — normal, not an
    error. See ABILITY.md for the exact task/question shape."""
    return json.loads(_run("work"))


def submit(task_id: str, answers: list[dict]) -> dict:
    """answers: [{"q_id": "...", "p": 0.62, "rationale": "..."}, ...] for binary
    questions, or {"choice": "..."} in place of "p" for choice questions.
    Resubmitting before the task's deadline replaces the prior answer."""
    out = _run("submit", task_id, "-", stdin=json.dumps(answers))
    return json.loads(out) if out.strip().startswith("{") else {"raw": out.strip()}


def status() -> str:
    """Human-readable status (skill, tier, points, streak) — not JSON; this
    command is meant for a person or a log line, not machine parsing."""
    return _run("status")
