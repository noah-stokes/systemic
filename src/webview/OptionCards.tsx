import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  cardPose,
  flickTarget,
  slotFromTurn,
  stageConfig,
  StageConfig,
} from "../shared/carousel";
import { DesignOption, SolveResult } from "../shared/protocol";

export type { SolveResult } from "../shared/protocol";

interface Props {
  result: SolveResult;
  onOpenSource: (source: string) => void;
  onDraft: (option: DesignOption) => void;
}

const SPIN_MS = 560;

const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** First sentence of the summary, as the card's sub-line. */
function lead(details: string): string {
  const match = details.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : details).trim();
}

export function OptionCards({ result, onOpenSource, onDraft }: Props) {
  const options = result.options ?? [];
  const count = options.length;

  const stageRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const turn = useRef(0);
  const raf = useRef(0);
  const drag = useRef<{ x: number; from: number } | null>(null);
  const [config, setConfig] = useState<StageConfig>(() => stageConfig(372));
  const [slot, setSlot] = useState(0);
  const [openSlot, setOpenSlot] = useState<number | null>(null);

  // The ring is animated by writing transforms directly — a state update per
  // frame would re-render three cards of prose at 60fps.
  const paint = (t: number, cfg: StageConfig) => {
    cardRefs.current.forEach((el, index) => {
      if (!el) {
        return;
      }
      const pose = cardPose(index, t, count, cfg);
      el.style.transform =
        `translate(-50%,-50%) translate3d(${pose.x.toFixed(1)}px,0,` +
        `${pose.z.toFixed(1)}px) rotateY(${pose.rotateY.toFixed(1)}deg)`;
      el.style.opacity = pose.opacity.toFixed(3);
      el.style.zIndex = String(pose.zIndex);
      el.style.filter = pose.dim ? "saturate(.5)" : "none";
    });
  };

  useLayoutEffect(() => {
    if (count > 1) {
      paint(turn.current, config);
    }
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || count < 2) {
      return;
    }
    const observer = new ResizeObserver(([entry]) =>
      setConfig(stageConfig(entry.contentRect.width)),
    );
    observer.observe(stage);
    return () => observer.disconnect();
  }, [count]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // rotating away collapses the card you left
  useEffect(() => setOpenSlot(null), [slot]);

  const focusOn = (t: number) => {
    const next = slotFromTurn(t, count);
    setSlot((current) => (current === next ? current : next));
  };

  const settle = (target: number) => {
    const wrapped = ((target % count) + count) % count;
    cancelAnimationFrame(raf.current);
    focusOn(target);
    if (reducedMotion()) {
      turn.current = wrapped;
      paint(turn.current, config);
      return;
    }
    const from = turn.current;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / SPIN_MS);
      const eased = 1 - Math.pow(1 - p, 3);
      turn.current = p < 1 ? from + (target - from) * eased : wrapped;
      paint(turn.current, config);
      if (p < 1) {
        raf.current = requestAnimationFrame(step);
      }
    };
    raf.current = requestAnimationFrame(step);
  };

  /** Rotate by whole cards, taking the short way round the ring. */
  const goTo = (index: number) => {
    let delta = (((index - slot) % count) + count) % count;
    if (delta > count / 2) {
      delta -= count;
    }
    settle(Math.round(turn.current) + delta);
  };

  const listeners = useRef<(() => void) | null>(null);

  const detach = () => {
    listeners.current?.();
    listeners.current = null;
  };

  useEffect(() => detach, []);

  const endDrag = (dx: number) => {
    const state = drag.current;
    detach();
    if (!state) {
      return;
    }
    drag.current = null;
    settle(flickTarget(state.from, dx, config));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (count < 2 || (event.target as HTMLElement).closest("button")) {
      return;
    }
    if (drag.current) {
      endDrag(0);
    }
    cancelAnimationFrame(raf.current);
    drag.current = { x: event.clientX, from: turn.current };
    const move = (moveEvent: PointerEvent) => {
      const state = drag.current;
      if (!state) {
        return;
      }
      turn.current = state.from - (moveEvent.clientX - state.x) / config.drag;
      paint(turn.current, config);
      focusOn(turn.current);
    };
    // Any of these ends the gesture — including the pointer leaving the webview.
    const end = (endEvent: Event) => {
      const state = drag.current;
      const x = (endEvent as PointerEvent).clientX;
      endDrag(state && typeof x === "number" ? x - state.x : 0);
    };
    detach();
    const ends = ["pointerup", "pointercancel", "lostpointercapture", "blur"];
    window.addEventListener("pointermove", move);
    ends.forEach((name) => window.addEventListener(name, end));
    listeners.current = () => {
      window.removeEventListener("pointermove", move);
      ends.forEach((name) => window.removeEventListener(name, end));
    };
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    settle(Math.round(turn.current) + (event.key === "ArrowRight" ? 1 : -1));
  };

  const card = (option: DesignOption, index: number) => {
    const focused = index === slot;
    const open = openSlot === index;
    const metrics = [
      ["BUILD", option.build],
      ["CEILING", option.ceiling],
      ["COST", option.cost],
    ].filter(([, value]) => value) as [string, string][];
    const points = option.points ?? [];
    const pipeline = option.pipeline ?? [];

    return (
      <article className={`option-card${focused ? " focused" : ""}`}>
        <div className="option-card-head">
          <div>
            <h3>{option.title}</h3>
            <p className="option-lead">{lead(option.details)}</p>
          </div>
          <span
            className={`ship-badge ${option.ships_as_is ? "ready" : "revision"}`}
          >
            {option.ships_as_is ? "ships as-is" : "needs revision"}
          </span>
        </div>

        {pipeline.length > 0 && (
          <div className="node-row">
            {pipeline.map((node, nodeIndex) => (
              <div className="node" key={`${node}-${nodeIndex}`}>
                <span
                  className="node-dot"
                  style={{ opacity: 1 - nodeIndex * 0.14 }}
                />
                <span className="node-label">{node}</span>
              </div>
            ))}
          </div>
        )}

        {points.length > 0 && (
          <ul className="points">
            {points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        )}

        <div className="metrics">
          {metrics.length > 0 ? (
            metrics.map(([label, value]) => (
              <div key={label}>
                <span className="card-label">{label}</span>
                <span>{value}</span>
              </div>
            ))
          ) : (
            <div>
              <span className="card-label">EFFORT</span>
              <span>{option.effort}</span>
            </div>
          )}
        </div>

        {open && (
          <div className="option-detail">
            <p>{option.details}</p>
            <span className="card-label">Tradeoffs</span>
            <p>{option.tradeoffs}</p>
            {(option.objective ?? []).length > 0 && (
              <div className="tags">
                {option.objective.map((tag) => (
                  <span className="tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {(option.risks ?? []).length > 0 && (
              <>
                <span className="card-label">Risks</span>
                <ul>
                  {option.risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="card-actions">
          <button className="draft-button" onClick={() => onDraft(option)}>
            Draft this <span aria-hidden="true">→</span>
          </button>
          <button
            className="details-button"
            aria-expanded={open}
            onClick={() => setOpenSlot(open ? null : index)}
          >
            {open ? "Less" : "Details"}
          </button>
        </div>
      </article>
    );
  };

  return (
    <section className="option-set">
      {count > 1 ? (
        <>
          <div
            className="deck-stage"
            ref={stageRef}
            style={{ perspective: `${Math.round(config.perspective)}px` }}
            tabIndex={0}
            role="group"
            aria-label={`${count} design options — use the left and right arrow keys to compare`}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
          >
            <div className="deck-track">
              {options.map((option, index) => (
                <div
                  className="deck-card"
                  key={`${option.title}-${index}`}
                  // rear cards are decorative: not clickable, not tabbable
                  inert={index !== slot}
                  ref={(el) => {
                    cardRefs.current[index] = el;
                  }}
                >
                  {card(option, index)}
                </div>
              ))}
            </div>
          </div>
          <div className="deck-nav">
            <div className="deck-dots">
              {options.map((option, index) => (
                <button
                  className={`deck-dot${index === slot ? " on" : ""}`}
                  key={`${option.title}-${index}`}
                  aria-label={`Show ${option.title}`}
                  aria-current={index === slot}
                  onClick={() => goTo(index)}
                />
              ))}
            </div>
            <span className="deck-label">
              {slot + 1} / {count}
            </span>
          </div>
        </>
      ) : (
        options.map((option, index) => (
          <div className="deck-card solo" key={`${option.title}-${index}`}>
            {card(option, index)}
          </div>
        ))
      )}

      {(result.comparison?.differences ||
        result.comparison?.recommendation) && (
        <article className="comparison">
          <div className="kicker">COMPARISON</div>
          {result.comparison.differences && (
            <p>{result.comparison.differences}</p>
          )}
          {result.comparison.recommendation && (
            <div className="recommendation">
              <span className="card-label">Recommendation</span>
              <p>{result.comparison.recommendation}</p>
            </div>
          )}
        </article>
      )}

      {((result.evidence ?? []).length > 0 ||
        (result.sources ?? []).length > 0) && (
        <details className="evidence">
          <summary>Evidence and sources</summary>
          {(result.evidence ?? []).length > 0 && (
            <>
              <div className="card-label">Repository evidence</div>
              <ul>
                {result.evidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {(result.sources ?? []).length > 0 && (
            <>
              <div className="card-label">External sources</div>
              <ul>
                {result.sources.map((source) => (
                  <li key={source}>
                    <button
                      className="source-link"
                      onClick={() => onOpenSource(source)}
                    >
                      {source}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}
    </section>
  );
}
