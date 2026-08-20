"""Multi-agent planning pipeline: explore context, propose options, review, synthesize.

solve() runs the stages directly as a fixed linear pipeline — context → options
→ reviews, with a bounded revision loop when no option clears REVIEW_BAR — then
returns a human-facing summary of each option. No orchestrator agent.
context_explorer and reviewer get read-only filesystem tools sandboxed to
REPO_ROOT so their claims are grounded in code actually read.
"""

import logging
import os
import re
import subprocess
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from threading import Event

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.agents.structured_output import ToolStrategy
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from pydantic import BaseModel

load_dotenv()

log = logging.getLogger(__name__)

MODEL = os.getenv("WORKER_MODEL", "moonshotai/kimi-k2.5")
OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_BASE_URL = os.getenv(
    "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
)
REPO_ROOT = Path(os.getenv("REPO_ROOT", ".")).resolve()
REVIEW_BAR = 7

OPTION_OBJECTIVES = {
    "minimal": (
        "Optimize for the smallest, least invasive patch. Fewest lines changed, "
        "fewest files touched, fewest new concepts. Scaling and future-proofing "
        "are non-goals — favor the shortest diff that correctly solves the "
        "stated problem."
    ),
    "scaling": (
        "Optimize for scaling and long-term extensibility, even at the cost of "
        "more upfront code. Assume load, data volume, or feature surface will "
        "grow — favor the design that holds up under that growth."
    ),
    "balanced": (
        "Optimize for the best tradeoff between minimal effort and "
        "scalability — a pragmatic middle ground, not the extreme of either."
    ),
}


def _model(model_id: str) -> ChatOpenAI:
    return ChatOpenAI(
        model=model_id,
        base_url=OPENROUTER_BASE_URL,
        api_key=OPENROUTER_KEY,
        max_retries=2,
        extra_body={
            "max_tokens": 5000,
        },
    )


IGNORE_DIRS = {
    ".aws",
    ".git",
    ".gnupg",
    ".mypy_cache",
    ".next",
    ".pytest_cache",
    ".ssh",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "deriveddata",
    "dist",
    "node_modules",
    "out",
    "pods",
    "target",
    "vendor",
    "venv",
}
SECRET_NAMES = {
    ".netrc",
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
    "service-account.json",
}
SECRET_SUFFIXES = {
    ".jks",
    ".key",
    ".keystore",
    ".p12",
    ".pem",
    ".pfx",
    ".tfstate",
}
PRIVATE_KEY_MARKER = re.compile(br"-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----")


class PipelineCancelled(RuntimeError):
    """Raised in the worker thread after its caller stops the request."""


def _raise_if_cancelled(cancel_event: Event | None) -> None:
    if cancel_event and cancel_event.is_set():
        raise PipelineCancelled("design pipeline cancelled")


class _CancelHandler(BaseCallbackHandler):
    """Stop an agent graph before it starts another paid model call."""

    raise_error = True

    def __init__(self, cancel_event: Event):
        self.cancel_event = cancel_event

    def on_chat_model_start(self, *_args, **_kwargs) -> None:
        _raise_if_cancelled(self.cancel_event)

    def on_llm_start(self, *_args, **_kwargs) -> None:
        _raise_if_cancelled(self.cancel_event)


def _safe(path: str) -> Path:
    """Resolve path against REPO_ROOT; raise if it escapes the sandbox."""
    p = (REPO_ROOT / path).resolve()
    if not p.is_relative_to(REPO_ROOT):
        raise ValueError(f"path escapes repo root: {path}")
    return p


@lru_cache(maxsize=8192)
def _contains_private_key(p: Path, _size: int, _mtime_ns: int) -> bool:
    """Cache content classification until the file changes."""
    try:
        with p.open("rb") as file:
            content = file.read()
    except OSError:
        return True
    return bool(
        PRIVATE_KEY_MARKER.search(content)
        or content.startswith(b"PuTTY-User-Key-File-")
    )


def _sensitive_path(p: Path) -> bool:
    """Recognize sensitive paths without opening their files."""
    rel = p.relative_to(REPO_ROOT)
    parts = [part.lower() for part in rel.parts]
    name = parts[-1]
    if any(part in IGNORE_DIRS for part in parts[:-1]):
        return True
    if name == ".env" or name.startswith(".env."):
        return True
    if name in SECRET_NAMES or p.suffix.lower() in SECRET_SUFFIXES:
        return True
    return False


def _git_ignored_paths(paths: list[Path]) -> set[Path]:
    """Use Git's own ignore rules, including nested and global excludes."""
    if not paths:
        return set()
    relative = [str(path.relative_to(REPO_ROOT)) for path in paths]
    try:
        result = subprocess.run(
            ["git", "check-ignore", "--no-index", "-z", "--stdin"],
            cwd=REPO_ROOT,
            input="\0".join(relative) + "\0",
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    if result.returncode not in (0, 1):
        return set()
    ignored = {path for path in result.stdout.split("\0") if path}
    return {
        path for path, rel in zip(paths, relative) if rel in ignored
    }


def _visible(
    p: Path,
    check_git_ignore: bool = True,
    check_private_key: bool = True,
) -> bool:
    """A readable, non-sensitive source file inside the repository boundary."""
    p = p.resolve()
    if not p.is_file() or not p.is_relative_to(REPO_ROOT) or _sensitive_path(p):
        return False
    if check_git_ignore and p in _git_ignored_paths([p]):
        return False
    if not check_private_key:
        return True
    try:
        stat = p.stat()
    except OSError:
        return False
    return not _contains_private_key(p, stat.st_size, stat.st_mtime_ns)


def _git_repo_files() -> list[Path] | None:
    """Return tracked and unignored untracked files, or None outside Git."""
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode:
        return None
    files = []
    for path in result.stdout.split("\0"):
        if not path:
            continue
        try:
            candidate = _safe(path)
        except ValueError:
            continue
        if _visible(
            candidate,
            check_git_ignore=False,
            check_private_key=False,
        ):
            files.append(candidate)
    ignored = _git_ignored_paths(files)
    return [path for path in files if path not in ignored]


_EXTGLOB = re.compile(r"[?*+@!]\(")


def _expand_braces(pattern: str) -> list[str]:
    """Expand `{a,b}` alternatives into separate patterns."""
    m = re.search(r"\{([^{}]*)\}", pattern)
    if not m:
        return [pattern]
    return [
        out
        for alt in m.group(1).split(",")
        for out in _expand_braces(pattern[: m.start()] + alt + pattern[m.end() :])
    ]


def _glob(pattern: str) -> list[Path]:
    """Visible repo files matching `pattern`, with braces expanded.

    pathlib understands neither brace nor extglob syntax and just matches
    nothing, so an agent reading "No matches." kept rewriting its pattern until
    it burned the whole recursion budget. Braces work; extglob raises.
    """
    if _EXTGLOB.search(pattern):
        raise ValueError(
            f"unsupported glob syntax {pattern!r} — use braces "
            '("**/*.{ts,tsx}"), not extglob ("**/*.ts?(x)")'
        )
    hits = {
        p.resolve()
        for pat in _expand_braces(pattern)
        for p in REPO_ROOT.glob(pat)
    }
    repo_files = _git_repo_files()
    if repo_files is not None:
        hits.intersection_update(repo_files)
        return sorted(hits)
    return sorted(p for p in hits if _visible(p, check_private_key=False))


@tool
def read_file(path: str, start: int = 1, end: int = 400) -> str:
    """Read a file inside the repo. `path` is relative to the repo root.
    Returns lines `start` through `end` (1-based, inclusive), each prefixed
    with its line number as `N:text`. Default window is the first 400 lines;
    call again with a higher `start` to read further."""
    try:
        p = _safe(path)
        if not _visible(p):
            raise PermissionError("file is ignored or sensitive")
        lines = p.read_text(errors="replace").splitlines()
        chunk = lines[max(start, 1) - 1 : end]
        if not chunk:
            return f"Error: no lines in range {start}-{end} (file has {len(lines)} lines)"
        return "\n".join(f"{i}:{line}" for i, line in enumerate(chunk, max(start, 1)))
    except Exception as e:
        return f"Error: {e}"


@tool
def glob_files(pattern: str) -> str:
    """List files in the repo matching a glob `pattern` relative to the repo
    root, e.g. "**/*.py", "src/api/*.ts", or "**/*.{ts,tsx}". Brace
    alternatives are supported; extglob ("?(x)") is not. Returns up to 100
    paths, one per line, with a truncation note if more matched."""
    try:
        hits = [str(p.relative_to(REPO_ROOT)) for p in _glob(pattern)]
        out = hits[:100]
        if len(hits) > 100:
            out.append(f"... truncated, {len(hits) - 100} more matches")
        return "\n".join(out) or "No matches."
    except Exception as e:
        return f"Error: {e}"


@tool
def grep(pattern: str, glob: str = "**/*") -> str:
    """Search file contents with a Python regex `pattern` across repo files
    matching `glob` (relative to the repo root, default every file; brace
    alternatives like "**/*.{ts,tsx}" are supported, extglob is not). Returns
    up to 50 hits as `path:line:text`, with a note if truncated."""
    try:
        rx = re.compile(pattern)
        hits = []
        for p in _glob(glob):
            if not _visible(p, check_git_ignore=False):
                continue
            try:
                text = p.read_text(errors="replace")
            except OSError:
                continue
            if "\0" in text:  # binary; searching it only yields junk lines
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if rx.search(line):
                    hits.append(f"{p.relative_to(REPO_ROOT)}:{i}:{line.strip()}")
                    if len(hits) >= 50:
                        return "\n".join(hits) + "\n... truncated at 50 hits"
        return "\n".join(hits) or "No matches."
    except Exception as e:
        return f"Error: {e}"


READ_TOOLS = [read_file, glob_files, grep]


class ContextReport(BaseModel):
    purpose: str
    relevant_components: list[str]
    existing_patterns: list[str]
    constraints: list[str]
    important_unknowns: list[str]
    research_needed: bool
    research_topics: list[str]
    questions: list[str]
    evidence: list[str]


context_explorer = create_agent(
    model=_model(MODEL),
    tools=READ_TOOLS,
    system_prompt=(
        "You are the context explorer. Given a user request, investigate the "
        "repo with your tools BEFORE writing the report: glob_files to orient "
        "in the tree (a file listing may already be provided — start from it), "
        "then grep for the concepts the request touches and read_file the "
        "files that matter. Describe the purpose of the request, the relevant "
        "existing components/files, patterns already used in the codebase that "
        "should be reused, and hard constraints. Every entry in `evidence` "
        "must cite a path and line range you actually read with read_file. "
        "Anything you could not verify with the tools goes in "
        "`important_unknowns` — never guess about code you haven't seen. "
        "Set `research_needed=True` and fill `research_topics` when the request "
        "depends on information outside the repo and outside your own knowledge "
        "— current library/framework versions, third-party API or service "
        "behavior, recent breaking changes, current best practices. Keep topics "
        "concrete and web-searchable. Otherwise set `research_needed=False` and "
        "leave `research_topics` empty. "
        "Also produce clarifying questions in `questions`: questions that pin "
        "down what the user actually wants — the goal, scope, and success "
        "criteria of the request — not how it should be implemented. Only ask "
        "what is not already answered by the prompt, the code, or the Q&A "
        "section; leave the field empty if the purpose is already unambiguous. "
        "Never re-ask a question that already appears in the Q&A section — a "
        "recorded decline counts as answered, so do not ask it again."
    ),
    response_format=ToolStrategy(ContextReport),
)


class ImplementationOption(BaseModel):
    name: str
    approach: str
    components_changed: list[str]
    implementation_steps: list[str]
    tradeoffs: list[str]
    risks: list[str]
    effort: str


option_explorer = create_agent(
    model=_model(MODEL),
    tools=READ_TOOLS,
    system_prompt=(
        "You are the option explorer. Given a problem statement, a context "
        "report, and an objective, propose one concrete implementation approach "
        "that optimizes for that objective above all else. A research report "
        "with current external findings may accompany the context report; when "
        "present, ground your approach in those findings. Be specific about "
        "which components change and the steps to implement it, and be honest "
        "about tradeoffs, risks, and effort. The context report already covers "
        "breadth; use your tools only for targeted depth — a few read_file/grep "
        "calls to verify the specific files you intend to change before "
        "committing to an approach. Do not re-explore the whole repo."
    ),
    response_format=ToolStrategy(ImplementationOption),
)


class OptionReview(BaseModel):
    option_name: str
    feasibility: str
    strengths: list[str]
    problems: list[str]
    required_changes: list[str]
    score: int


reviewer = create_agent(
    model=_model(MODEL),
    tools=READ_TOOLS,
    system_prompt=(
        "You are the reviewer. Given a context report, one proposed "
        "implementation option, and the objective that option was built to "
        "serve, critically check it for correctness and feasibility. Verify "
        "claims against the actual code with your tools: grep and read_file the "
        "components the option says it changes before asserting a strength or a "
        "problem — do not take the option's description of the codebase on "
        "faith. Judge feasibility RELATIVE TO THE STATED OBJECTIVE. A "
        "correctness or feasibility defect is ALWAYS a problem — a bug does not "
        "stop being a bug because the objective is 'minimal'. Only when the "
        "option fails under a condition its objective EXPLICITLY declines to "
        "serve — e.g. a minimal option that does not scale, when its objective "
        "states scaling is a non-goal — is that an inherent tradeoff rather than "
        "a problem or a required change; do not demand robustness the objective "
        "told the option to skip. List concrete strengths and problems, note any required "
        "changes before it would be safe to implement, and score it 1-10 on "
        "this rubric: 9-10 ships as-is, 7-8 ships with minor changes, 4-6 needs "
        "rework before it is safe, 1-3 fundamentally unsound. The score gates "
        "whether the option is sound enough to ship — it is not a ranking "
        "against the other options. Be skeptical — the goal is to catch "
        "mistakes, not to be agreeable."
    ),
    response_format=ToolStrategy(OptionReview),
)


class ResearchReport(BaseModel):
    summary: str
    findings: list[str]
    sources: list[str]
    unknowns: list[str]


research_agent = create_agent(
    model=_model(MODEL + ":online"),
    tools=[],
    system_prompt=(
        "You are the research agent. You run when the context report flagged "
        "that the request depends on information not available in the repo. "
        "Given the context report and its research_topics, use your online "
        "search to find current, authoritative answers. Cite every finding "
        "with the URL it came from in `sources` — never assert a fact you did "
        "not find via search. Put topics you could not resolve in `unknowns`. "
        "Be concrete and specific; this feeds directly into implementation-"
        "option design."
    ),
    response_format=ToolStrategy(ResearchReport),
)


def _structured(
    agent,
    text: str,
    recursion_limit: int = 40,
    cancel_event: Event | None = None,
):
    _raise_if_cancelled(cancel_event)
    config = {"recursion_limit": recursion_limit}
    if cancel_event:
        config["callbacks"] = [_CancelHandler(cancel_event)]
    result = agent.invoke(
        {"messages": [{"role": "user", "content": text}]},
        config,
    )
    if "structured_response" not in result:
        raise RuntimeError("model returned no structured response")
    return result["structured_response"]


def _map_stage(
    fn, items: list, stage: str, cancel_event: Event | None = None
) -> list:
    """Map fn over items in parallel, preserving slots: a failed call yields
    None in its position so callers keep alignment with their keys. Raise only
    if every call failed."""

    errors: list[Exception] = []

    def _worker(item):
        _raise_if_cancelled(cancel_event)
        try:
            return fn(item)
        except PipelineCancelled:
            raise
        except Exception as exc:
            log.exception("%s: worker failed", stage)
            errors.append(exc)
            return None

    if not items:
        return []
    _raise_if_cancelled(cancel_event)
    with ThreadPoolExecutor(max_workers=len(items)) as pool:
        results = list(pool.map(_worker, items))
    _raise_if_cancelled(cancel_event)
    if all(r is None for r in results):
        # chain the first cause: the message reaches the user, and "all 3 calls
        # failed" alone says nothing about why.
        raise RuntimeError(
            f"{stage}: all {len(items)} calls failed: {errors[0]}"
        ) from errors[0]
    return results


def _dedupe_groups(duplicate_groups: list[list[str]], keys: list[str]) -> list[list[str]]:
    """Partition keys into cards: each LLM-flagged duplicate group is merged,
    every unlisted key is its own singleton. Union-find so overlapping groups,
    repeats, or keys the LLM invented all resolve to one card per key, in
    keys order (so a group's first element is its earliest key)."""
    parent = {k: k for k in keys}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for group in duplicate_groups:
        members = [k for k in group if k in parent]
        for k in members[1:]:
            parent[find(k)] = find(members[0])
    groups: dict[str, list[str]] = {}
    for k in keys:
        groups.setdefault(find(k), []).append(k)
    return list(groups.values())


def get_context(
    problem: str,
    qa: list[str] | None = None,
    prior: ContextReport | None = None,
    cancel_event: Event | None = None,
) -> ContextReport:
    """Run context_explorer on problem, primed with a repo file listing.

    qa appends answered clarifying questions, one already-paired line each
    ("Q: ... A: ..."); prior passes the previous report so the explorer
    updates it instead of re-exploring from scratch.
    """
    files = _git_repo_files() or []
    if files:
        relative = [str(path.relative_to(REPO_ROOT)) for path in files]
        listing = "\n".join(relative[:200])
        if len(files) > 200:
            listing += f"\n... truncated, {len(files) - 200} more"
        problem = f"Repo files:\n{listing}\n\nRequest:\n{problem}"
    if prior:
        problem += (
            "\n\nYour previous context report (update it with the answers below; "
            "re-verify only what they change):\n" + prior.model_dump_json()
        )
    if qa:
        problem += "\n\nUser answered these clarifying questions:\n" + "\n".join(qa)
    kwargs = {"cancel_event": cancel_event} if cancel_event else {}
    return _structured(context_explorer, problem, **kwargs)


def get_research(
    context: ContextReport, cancel_event: Event | None = None
) -> ResearchReport:
    """Run research_agent on the context report's flagged research topics."""
    topics = "\n".join(f"- {t}" for t in context.research_topics)
    prompt = f"{context.model_dump_json()}\n\nResearch these topics:\n{topics}"
    kwargs = {"cancel_event": cancel_event} if cancel_event else {}
    return _structured(research_agent, prompt, recursion_limit=15, **kwargs)


def get_options(
    context: ContextReport,
    prior: dict[str, tuple[ImplementationOption, OptionReview]] | None = None,
    research: ResearchReport | None = None,
    cancel_event: Event | None = None,
) -> dict[str, ImplementationOption]:
    """Run option_explorer once per objective in OPTION_OBJECTIVES, in parallel.

    Returns options keyed by objective. prior maps objective key to that
    objective's (option, review) from a failed round, so each explorer revises
    its own proposal against its own critique — never another objective's.
    research, when present, supplies current external findings gathered by the
    research stage.
    """
    research_ctx = ""
    if research:
        research_ctx = (
            "\n\nResearch report (current external findings — ground your "
            "approach in these):\n" + research.model_dump_json()
        )

    def _one(key: str) -> ImplementationOption:
        critique = ""
        if prior and key in prior:
            opt, rev = prior[key]
            critique = (
                "\n\nThe reviewer rejected your previous option. Revise it — "
                "do not start over — to fix the findings, but keep serving your "
                "objective above all: if a required change conflicts with the "
                "objective, keep the objective and note the tension rather than "
                "drifting toward a different objective.\n"
                f"Your previous option:\n{opt.model_dump_json()}\n"
                f"Problems: {'; '.join(rev.problems)}\n"
                f"Required changes: {'; '.join(rev.required_changes)}"
            )
        # default recursion_limit: the explorer verifies files with READ_TOOLS,
        # and a tighter budget kills every worker at once with GraphRecursionError.
        kwargs = {"cancel_event": cancel_event} if cancel_event else {}
        return _structured(
            option_explorer,
            f"{context.model_dump_json()}{research_ctx}\n\n"
            f"Objective:\n{OPTION_OBJECTIVES[key]}{critique}",
            **kwargs,
        )

    keys = list(prior) if prior else list(OPTION_OBJECTIVES)
    return {
        k: o
        for k, o in zip(
            keys, _map_stage(_one, keys, "get_options", cancel_event=cancel_event)
        )
        if o is not None
    }


def review_options(
    context: ContextReport,
    options: dict[str, ImplementationOption],
    cancel_event: Event | None = None,
) -> dict[str, OptionReview]:
    """Run reviewer on each option in parallel, keyed by objective."""
    keys = list(options)
    results = _map_stage(
        lambda k: _structured(
            reviewer,
            f"Context:\n{context.model_dump_json()}\n\n"
            f"Objective:\n{OPTION_OBJECTIVES[k]}\n\n"
            f"Option:\n{options[k].model_dump_json()}",
            **({"cancel_event": cancel_event} if cancel_event else {}),
        ),
        keys,
        "review_options",
        cancel_event=cancel_event,
    )
    return {k: r for k, r in zip(keys, results) if r is not None}


class OptionSummary(BaseModel):
    title: str
    details: str
    tradeoffs: str
    # Card spec fields. Defaulted, so a model that omits one — or a chat saved
    # before these existed — still renders; the UI drops empty cells.
    pipeline: list[str] = []
    points: list[str] = []
    build: str = ""
    ceiling: str = ""
    cost: str = ""


summarizer = create_agent(
    model=_model(MODEL),
    tools=None,
    system_prompt=(
        "You are the summarizer. Given a context report, one implementation "
        "option, and its review, write a human-facing summary of that option. "
        "Plain prose, no jargon dumps, no bullet fragments. `title` names the "
        "implementation in a few words. `details` explains what the approach "
        "does and what changes, in flowing prose. `tradeoffs` honestly covers "
        "costs, risks, and review findings — fold the reviewer's problems in.\n"
        "The remaining fields are a compact card spec, not prose. `pipeline` is "
        "2-4 SHORT UPPERCASE labels naming the runtime flow left to right "
        "(CLIENT, API, REDIS, POSTGRES) — the shape of the system, not the "
        "files changed. `points` is exactly two clauses of at most nine words "
        "each, the load-bearing facts about this approach; no sentences, no "
        "trailing periods. `build` is the time to ship it, from the option's "
        "effort (e.g. `1 week`). `ceiling` is where the approach stops holding, "
        "as a bound (e.g. `8k rps`, `~50 services`). `cost` is `$`, `$$`, or "
        "`$$$` — the ongoing operational cost relative to the other options. "
        "Leave any of `build`, `ceiling`, or `cost` empty rather than inventing "
        "a number the option and its review do not support."
    ),
    response_format=ToolStrategy(OptionSummary),
)


def summarize_options(
    context: ContextReport,
    options: dict[str, ImplementationOption],
    reviews: dict[str, OptionReview],
    cancel_event: Event | None = None,
) -> dict[str, OptionSummary]:
    """Run summarizer on each option/review pair in parallel, keyed by objective."""
    keys = [k for k in options if k in reviews]
    results = _map_stage(
        lambda k: _structured(
            summarizer,
            f"Context:\n{context.model_dump_json()}\n\n"
            f"Option:\n{options[k].model_dump_json()}\n\n"
            f"Review:\n{reviews[k].model_dump_json()}",
            **({"cancel_event": cancel_event} if cancel_event else {}),
        ),
        keys,
        "summarize_options",
        cancel_event=cancel_event,
    )
    return {k: s for k, s in zip(keys, results) if s is not None}


class Comparison(BaseModel):
    differences: str
    recommendation: str
    duplicate_groups: list[list[str]]


comparator = create_agent(
    model=_model(MODEL),
    tools=None,
    system_prompt=(
        "You are the comparator. Given the context report and every proposed "
        "implementation option with its review, write a human-facing comparison "
        "to help the user choose. `differences` explains what actually differs "
        "between the options — and says so plainly if they converged on nearly "
        "the same design. `recommendation` names the option you would pick and "
        "why, grounded in the user's actual situation from the context report "
        "(its `purpose` and `constraints` — is this a prototype or a system "
        "under load?), not merely in which option scored highest; the reviewer "
        "scores gate soundness, they do not rank the options. Name any option "
        "whose review scored below 7 (the ship bar) so the user knows it is not "
        "yet safe to ship as-is. In `duplicate_groups`, group the option keys "
        "(e.g. \"minimal\", \"scaling\") that converged on the SAME approach — "
        "same components changed, same mechanism, wording aside; not an exact "
        "match. Each group is a list of two or more keys; put every genuinely "
        "distinct option in its own group or omit it. These groups are merged "
        "into one card each, so only group options a user would see as the same "
        "plan. Plain prose, no jargon dumps."
    ),
    response_format=ToolStrategy(Comparison),
)


def _card_body(summary: OptionSummary | None, option: ImplementationOption) -> dict:
    """Card prose from the summarizer, or straight from the option if it failed.

    The raw option is duller than a written summary but still renders — losing
    a whole option because its summarizer call died is the worse outcome.
    """
    if summary:
        return summary.model_dump()
    return OptionSummary(
        title=option.name,
        details=option.approach,
        tradeoffs="; ".join(option.tradeoffs),
        points=option.implementation_steps[:2],
        build=option.effort,
    ).model_dump()


def solve(
    problem: str,
    max_rounds: int = 2,
    qa: list[str] | None = None,
    progress: Callable[[str], None] | None = None,
    cancel_event: Event | None = None,
) -> dict:
    """Run the pipeline deterministically.

    Returns {"options": [...], "comparison": {...}, "evidence": [...],
    "sources": [...]}: one summary dict per objective (with the reviewer's
    score and the explorer's effort/risks attached), a cross-option
    comparison, and the evidence/sources the pipeline gathered.

    Clarifying questions are asked across two calls, not mid-run: with no qa,
    a context report that has questions returns immediately as
    {"questions": [...], ...} and nothing else runs. The caller collects
    answers and calls again with qa as one already-paired line per question
    ("Q: ... A: ..."), which primes the explorer and runs the pipeline through.

    progress, if given, is called with a human-readable string at each stage
    boundary.
    """
    say = progress or (lambda _stage: None)
    kwargs = {"cancel_event": cancel_event} if cancel_event else {}
    _raise_if_cancelled(cancel_event)
    say("Exploring the codebase…")
    context = get_context(problem, qa=qa, **kwargs)
    _raise_if_cancelled(cancel_event)
    if not qa and context.questions:
        return {
            "questions": context.questions,
            "options": [],
            "comparison": {},
            "evidence": context.evidence,
            "sources": [],
        }
    # ponytail: research runs once — the revision loop never re-runs
    # get_context, so no new research topics can appear; refresh it if the
    # loop ever re-explores context.
    research = None
    if context.research_needed and context.research_topics:
        say("Researching current practice…")
        research = get_research(context, **kwargs)
        _raise_if_cancelled(cancel_event)
    say(f"Drafting {len(OPTION_OBJECTIVES)} approaches…")
    options = get_options(context, research=research, **kwargs)
    _raise_if_cancelled(cancel_event)
    say("Reviewing approaches…")
    reviews = review_options(context, options, **kwargs)
    _raise_if_cancelled(cancel_event)
    best_options, best_reviews = dict(options), dict(reviews)
    for round_no in range(2, max_rounds + 1):
        # failing: below the bar, OR generated but never successfully reviewed
        # (a reviewer error), so a transient failure re-reviews instead of
        # silently dropping the option.
        failing = [
            k
            for k in best_options
            if k not in best_reviews or best_reviews[k].score < REVIEW_BAR
        ]
        if not failing:
            break
        say(f"Revising (round {round_no})…")
        # revise from the latest attempt; a key with no latest review is carried
        # forward unchanged to be re-reviewed. best_* is only for presentation.
        to_revise = {k: (options[k], reviews[k]) for k in failing if k in reviews}
        revised = (
            get_options(context, prior=to_revise, research=research, **kwargs)
            if to_revise
            else {}
        )
        carried = {k: best_options[k] for k in failing if k not in revised}
        options = {**carried, **revised}
        _raise_if_cancelled(cancel_event)
        reviews = review_options(context, options, **kwargs)
        _raise_if_cancelled(cancel_event)
        for k, r in reviews.items():
            if k not in best_reviews or r.score > best_reviews[k].score:
                best_options[k], best_reviews[k] = options[k], r

    if not best_options:
        return {
            "options": [],
            "comparison": {},
            "evidence": context.evidence,
            "sources": research.sources if research else [],
        }

    # comparator runs first: it ranks and flags which options are the same
    # approach, so we summarize only the survivors of the merge. score gates the
    # loop and feeds ships_as_is — it is never surfaced as a cross-option rank.
    # comparison is presentation-only: if it fails, every option still stands on
    # its own, so degrade to one card per option rather than dropping the work.
    say("Comparing approaches…")
    try:
        _raise_if_cancelled(cancel_event)
        comparison = _structured(
            comparator,
            f"Context:\n{context.model_dump_json()}\n\n"
            + "\n\n".join(
                f"Option [{k}]:\n{best_options[k].model_dump_json()}\n"
                f"Review:\n{best_reviews[k].model_dump_json()}"
                for k in best_options
                if k in best_reviews
            ),
            **kwargs,
        )
        comparison_data = comparison.model_dump()
        groups = _dedupe_groups(comparison.duplicate_groups, list(best_options))
    except PipelineCancelled:
        raise
    except Exception:
        log.exception("comparator failed; presenting options uncompared")
        comparison_data = {}
        groups = [[k] for k in best_options]
    survivors = {g[0]: best_options[g[0]] for g in groups}
    survivor_reviews = {g[0]: best_reviews[g[0]] for g in groups if g[0] in best_reviews}
    # last stage: a total summarizer failure would otherwise raise out of solve()
    # and lose the options, comparison, and evidence already paid for.
    say("Writing up options…")
    try:
        summaries = summarize_options(
            context, survivors, survivor_reviews, **kwargs
        )
    except PipelineCancelled:
        raise
    except Exception:
        log.exception("summarize_options failed; falling back to raw options")
        summaries = {}
    cards = []
    for g in groups:
        rep = g[0]
        scores = [best_reviews[k].score for k in g if k in best_reviews]
        risks = [risk for k in g for risk in best_options[k].risks]
        cards.append(
            {
                **_card_body(summaries.get(rep), best_options[rep]),
                "objective": g,  # one card may cover several merged objectives
                "effort": best_options[rep].effort,
                "risks": list(dict.fromkeys(risks)),  # union, order preserved
                "ships_as_is": bool(scores) and min(scores) >= REVIEW_BAR,
            }
        )
    return {
        "options": cards,
        "comparison": comparison_data,
        "evidence": context.evidence,
        "sources": research.sources if research else [],
    }
