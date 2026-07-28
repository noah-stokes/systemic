"""Offline checks for orchestrator key alignment and best-round tracking.

Agent calls are stubbed — no API traffic. Run from backend/:
    python test_system_design.py
"""

import ai.system_design as orch

CTX = orch.ContextReport(
    purpose="p",
    relevant_components=[],
    existing_patterns=[],
    constraints=[],
    important_unknowns=[],
    research_needed=False,
    research_topics=[],
    questions=[],
    evidence=["file.py:1-2"],
)


def opt(name: str) -> orch.ImplementationOption:
    return orch.ImplementationOption(
        name=name,
        approach=f"approach-{name}",
        components_changed=[],
        implementation_steps=[],
        tradeoffs=[],
        risks=[f"risk-{name}"],
        effort=f"effort-{name}",
    )


def rev(name: str, score: int) -> orch.OptionReview:
    return orch.OptionReview(
        option_name=name,
        feasibility="ok",
        strengths=[],
        problems=[],
        required_changes=[],
        score=score,
    )


def test_map_stage_empty_and_slots():
    assert orch._map_stage(lambda x: x, [], "s") == []
    out = orch._map_stage(lambda x: 1 / x, [1, 0, 2], "s")
    assert out[0] == 1 and out[1] is None and out[2] == 0.5


def test_map_stage_total_failure_reports_the_cause():
    try:
        orch._map_stage(lambda x: 1 / x, [0, 0], "s")
    except RuntimeError as exc:
        assert "division by zero" in str(exc), str(exc)
        assert isinstance(exc.__cause__, ZeroDivisionError)
    else:
        raise AssertionError("total failure did not raise")


def test_glob_expands_braces_and_rejects_extglob():
    assert orch._expand_braces("**/*.{ts,tsx}") == ["**/*.ts", "**/*.tsx"]
    assert orch._expand_braces("**/*.py") == ["**/*.py"]
    # this file is .py, so a brace pattern covering .py must find it
    hits = [p.name for p in orch._glob("*.{py,md}")]
    assert "test_system_design.py" in hits, hits
    try:
        orch._glob("**/*.ts?(x)")
    except ValueError as exc:
        assert "extglob" in str(exc)
    else:
        raise AssertionError("extglob pattern silently matched nothing")


def test_grep_defaults_to_every_file():
    # the default used to be "**/*.py", so greps in a non-Python repo always
    # came back empty and the agent burned its budget rewriting the pattern.
    hit = orch.grep.invoke({"pattern": "test_grep_defaults_to_every_file"})
    assert "test_system_design.py:" in hit, hit


def test_structured_requires_a_structured_response():
    class Agent:
        def invoke(self, *_args):
            return {"messages": []}

    try:
        orch._structured(Agent(), "problem")
    except RuntimeError as exc:
        assert str(exc) == "model returned no structured response"
    else:
        raise AssertionError("missing structured response was accepted")


def test_openrouter_tool_choice_is_compatible():
    model = orch._model(orch.MODEL)
    bound = model.bind_tools([orch.read_file], tool_choice="any")
    assert bound.kwargs["tool_choice"] == "required"
    assert "provider" not in model.extra_body


def test_get_options_keeps_keys_when_one_worker_fails():
    def fake(agent, text, recursion_limit=25):
        if orch.OPTION_OBJECTIVES["scaling"] in text:
            raise RuntimeError("boom")
        for key, objective in orch.OPTION_OBJECTIVES.items():
            if objective in text:
                return opt(key)
        raise AssertionError("no objective in prompt")

    orig, orch._structured = orch._structured, fake
    try:
        options = orch.get_options(CTX)
    finally:
        orch._structured = orig
    assert set(options) == {"minimal", "balanced"}, set(options)
    assert options["minimal"].name == "minimal"
    assert options["balanced"].name == "balanced"


def test_get_options_revises_only_failing_keys():
    def fake(agent, text, recursion_limit=25):
        for key, objective in orch.OPTION_OBJECTIVES.items():
            if objective in text:
                return opt(key)
        raise AssertionError("no objective in prompt")

    orig, orch._structured = orch._structured, fake
    try:
        prior = {"minimal": (opt("minimal"), rev("minimal", 3))}
        options = orch.get_options(CTX, prior=prior)
    finally:
        orch._structured = orig
    assert set(options) == {"minimal"}, set(options)


def test_summarize_pairs_option_with_its_own_review():
    options = {k: opt(k) for k in ("minimal", "scaling", "balanced")}
    reviews = {k: rev(k, 8) for k in ("minimal", "balanced")}  # scaling review lost

    def fake(agent, text, recursion_limit=25):
        for k in options:
            if f"approach-{k}" in text:
                assert f'"option_name":"{k}"' in text, f"misaligned pair for {k}"
                return orch.OptionSummary(title=k, details="d", tradeoffs="t")
        raise AssertionError("no option in prompt")

    orig, orch._structured = orch._structured, fake
    try:
        summaries = orch.summarize_options(CTX, options, reviews)
    finally:
        orch._structured = orig
    assert set(summaries) == {"minimal", "balanced"}, set(summaries)


def test_card_spec_fields_default_empty():
    # the webview drops empty cells, so a model that omits them must not fail
    s = orch.OptionSummary(title="t", details="d", tradeoffs="t")
    assert (s.pipeline, s.points) == ([], [])
    assert (s.build, s.ceiling, s.cost) == ("", "", "")


def test_solve_returns_best_round_not_last():
    rounds = [
        ({"minimal": opt("good")}, {"minimal": rev("good", 6)}),
        ({"minimal": opt("worse")}, {"minimal": rev("worse", 3)}),
    ]
    state = {"i": 0}

    def fake_get_options(context, prior=None, research=None):
        return rounds[state["i"]][0]

    def fake_review(context, options):
        out = rounds[state["i"]][1]
        state["i"] += 1
        return out

    def fake_structured(agent, text, recursion_limit=25):
        if agent is orch.comparator:
            return orch.Comparison(
                differences="d", recommendation="pick good", duplicate_groups=[]
            )
        return orch.OptionSummary(
            title="t",
            details="d",
            tradeoffs="t",
            pipeline=["CLIENT", "API"],
            points=["p1", "p2"],
            build="1 week",
            ceiling="8k rps",
            cost="$",
        )

    orig = (orch.get_context, orch.get_options, orch.review_options, orch._structured)
    orch.get_context = lambda problem, qa=None, prior=None: CTX
    orch.get_options = fake_get_options
    orch.review_options = fake_review
    orch._structured = fake_structured
    try:
        result = orch.solve("problem", max_rounds=2)
    finally:
        orch.get_context, orch.get_options, orch.review_options, orch._structured = orig

    assert state["i"] == 2, "revision round did not run"
    [option] = result["options"]
    assert "score" not in option, "score is a gate, not a card field"
    assert option["effort"] == "effort-good"
    assert option["risks"] == ["risk-good"]
    assert option["objective"] == ["minimal"]
    assert option["ships_as_is"] is False, "best score 6 < REVIEW_BAR 7"
    assert option["pipeline"] == ["CLIENT", "API"]
    assert option["points"] == ["p1", "p2"]
    assert (option["build"], option["ceiling"], option["cost"]) == (
        "1 week",
        "8k rps",
        "$",
    )
    assert result["comparison"]["recommendation"] == "pick good"
    assert result["evidence"] == ["file.py:1-2"]
    assert result["sources"] == []


def test_solve_survives_comparator_and_summarizer_failure():
    # a GraphRecursionError in either late stage used to discard every option
    # the pipeline had already paid for.
    def fake_structured(agent, text, recursion_limit=25):
        raise RuntimeError("Recursion limit of 40 reached")

    orig = (orch.get_context, orch.get_options, orch.review_options, orch._structured)
    orch.get_context = lambda problem, qa=None, prior=None: CTX
    orch.get_options = lambda context, prior=None, research=None: {
        "minimal": opt("minimal")
    }
    orch.review_options = lambda context, options: {"minimal": rev("minimal", 9)}
    orch._structured = fake_structured
    try:
        result = orch.solve("problem", max_rounds=1)
    finally:
        orch.get_context, orch.get_options, orch.review_options, orch._structured = orig

    assert result["comparison"] == {}, result["comparison"]
    [option] = result["options"]
    assert option["title"] == "minimal", option  # fell back to the raw option
    assert option["details"] == "approach-minimal"
    assert option["ships_as_is"] is True
    assert result["evidence"] == ["file.py:1-2"]


def test_solve_short_circuits_on_unanswered_questions():
    # questions come back to the caller as a turn of their own; nothing past
    # get_context may run or the user pays for a pipeline built on guesses.
    asked = CTX.model_copy(update={"questions": ["what scale?"]})

    def boom(*_args, **_kwargs):
        raise AssertionError("get_options ran with questions outstanding")

    orig = (orch.get_context, orch.get_options)
    orch.get_context = lambda problem, qa=None, prior=None: asked
    orch.get_options = boom
    try:
        result = orch.solve("problem")
    finally:
        orch.get_context, orch.get_options = orig

    assert result["questions"] == ["what scale?"], result
    assert result["options"] == [] and result["comparison"] == {}
    assert result["evidence"] == ["file.py:1-2"]


def test_solve_with_answers_runs_the_pipeline():
    asked = CTX.model_copy(update={"questions": ["what scale?"]})
    seen = {}

    def fake_context(problem, qa=None, prior=None):
        seen["qa"] = qa
        return asked

    def fake_structured(agent, text, recursion_limit=25):
        if agent is orch.comparator:
            return orch.Comparison(
                differences="d", recommendation="r", duplicate_groups=[]
            )
        return orch.OptionSummary(title="t", details="d", tradeoffs="t")

    orig = (orch.get_context, orch.get_options, orch.review_options, orch._structured)
    orch.get_context = fake_context
    orch.get_options = lambda context, prior=None, research=None: {
        "minimal": opt("minimal")
    }
    orch.review_options = lambda context, options: {"minimal": rev("minimal", 9)}
    orch._structured = fake_structured
    try:
        result = orch.solve("problem", max_rounds=1, qa=["Q: what scale? A: small"])
    finally:
        orch.get_context, orch.get_options, orch.review_options, orch._structured = orig

    assert seen["qa"] == ["Q: what scale? A: small"]
    assert "questions" not in result, result
    assert len(result["options"]) == 1, result["options"]


def test_dedupe_groups_merges_and_partitions():
    # unlisted keys stay singletons; overlapping groups collapse to one card;
    # invented keys are ignored; output stays in keys order.
    keys = ["minimal", "scaling", "balanced"]
    assert orch._dedupe_groups([], keys) == [["minimal"], ["scaling"], ["balanced"]]
    assert orch._dedupe_groups([["minimal", "scaling"]], keys) == [
        ["minimal", "scaling"],
        ["balanced"],
    ]
    assert orch._dedupe_groups(
        [["minimal", "scaling"], ["scaling", "balanced"]], keys
    ) == [["minimal", "scaling", "balanced"]]
    assert orch._dedupe_groups([["minimal", "ghost"]], keys) == [
        ["minimal"],
        ["scaling"],
        ["balanced"],
    ]


if __name__ == "__main__":
    test_map_stage_empty_and_slots()
    test_map_stage_total_failure_reports_the_cause()
    test_glob_expands_braces_and_rejects_extglob()
    test_grep_defaults_to_every_file()
    test_structured_requires_a_structured_response()
    test_openrouter_tool_choice_is_compatible()
    test_get_options_keeps_keys_when_one_worker_fails()
    test_get_options_revises_only_failing_keys()
    test_dedupe_groups_merges_and_partitions()
    test_summarize_pairs_option_with_its_own_review()
    test_solve_short_circuits_on_unanswered_questions()
    test_solve_with_answers_runs_the_pipeline()
    test_solve_returns_best_round_not_last()
    test_solve_survives_comparator_and_summarizer_failure()
    print("ok")
