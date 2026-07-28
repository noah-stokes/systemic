import React, { useState } from "react";

interface Props {
  questions: string[];
  disabled: boolean;
  onSubmit: (message: string) => void;
}

/** Answers go back as an ordinary chat turn — no dedicated host message. */
export function QuestionCard({ questions, disabled, onSubmit }: Props) {
  const [answers, setAnswers] = useState(() => questions.map(() => ""));
  // ponytail: local state, so reopening the chat from disk makes the card
  // answerable again. Persist a flag on the message if that ever matters.
  const [answered, setAnswered] = useState(false);

  const submit = (skip: boolean) => {
    setAnswered(true);
    onSubmit(
      questions
        .map((question, index) => {
          const answer = skip ? "" : answers[index].trim();
          return `${index + 1}. ${question} — ${answer || "(skipped)"}`;
        })
        .join("\n"),
    );
  };

  const locked = disabled || answered;

  return (
    <section className="question-card">
      <div className="kicker">CLARIFYING QUESTIONS</div>
      <ol className="question-list">
        {questions.map((question, index) => (
          <li key={`${question}-${index}`}>
            <label>
              <span>{question}</span>
              <input
                value={answers[index]}
                disabled={locked}
                placeholder="Your answer"
                onChange={(event) =>
                  setAnswers((current) =>
                    current.map((value, at) =>
                      at === index ? event.target.value : value,
                    ),
                  )
                }
              />
            </label>
          </li>
        ))}
      </ol>
      <div className="card-actions">
        <button
          className="draft-button"
          disabled={locked}
          onClick={() => submit(false)}
        >
          Submit
        </button>
        <button
          className="details-button"
          disabled={locked}
          onClick={() => submit(true)}
        >
          Skip all
        </button>
      </div>
    </section>
  );
}
