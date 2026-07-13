"use client";

import { useState } from "react";

interface Citation {
  id: string;
  source: string;
  heading: string | null;
  snippet: string;
  content: string;
}

interface ChatResponse {
  answer: string;
  grounded: boolean;
  citations: Citation[];
  usage?: { costUsd: number; latencyMs: number };
  error?: string;
}

const SUGGESTIONS = [
  "What is Mimir?",
  "How does it avoid hallucinations?",
  "How do I swap in my own documents?",
  "What does the eval measure?",
];

/**
 * Self-contained chat UI for the standalone demo page. Same-origin, so it calls
 * /api/chat relatively. Shows the grounded answer, an honest-refusal state, and
 * the source chunks each answer cites.
 */
export default function AskWidget({ apiUrl = "/api/chat" }: { apiUrl?: string }) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ChatResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    setResponse(null);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const data: ChatResponse = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
      } else {
        setResponse(data);
      }
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        style={{ display: "flex", gap: "0.5rem" }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask the knowledge base…"
          maxLength={600}
          style={{
            flex: 1,
            padding: "0.6rem 0.75rem",
            fontFamily: "inherit",
            fontSize: "0.95rem",
            border: "1px solid #ccc",
            borderRadius: "6px",
          }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "0.6rem 1.1rem",
            fontFamily: "inherit",
            fontSize: "0.95rem",
            border: "none",
            borderRadius: "6px",
            background: loading ? "#999" : "#111",
            color: "#fff",
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "…" : "Ask"}
        </button>
      </form>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.6rem" }}>
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => {
              setQuestion(s);
              ask(s);
            }}
            disabled={loading}
            style={{
              padding: "0.3rem 0.6rem",
              fontSize: "0.8rem",
              fontFamily: "inherit",
              border: "1px solid #ddd",
              borderRadius: "999px",
              background: "#fafafa",
              cursor: loading ? "default" : "pointer",
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {error && (
        <p style={{ marginTop: "1.25rem", color: "#b00", fontSize: "0.9rem" }}>{error}</p>
      )}

      {response && (
        <div style={{ marginTop: "1.5rem" }}>
          <div
            style={{
              display: "inline-block",
              padding: "0.15rem 0.55rem",
              borderRadius: "999px",
              fontSize: "0.72rem",
              fontWeight: 600,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              background: response.grounded ? "#e6f4ea" : "#fdeeee",
              color: response.grounded ? "#1a7f37" : "#b00",
            }}
          >
            {response.grounded ? "Grounded" : "Not in the knowledge base"}
          </div>

          <p style={{ marginTop: "0.75rem", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
            {response.answer}
          </p>

          {response.citations.length > 0 && (
            <div style={{ marginTop: "1.25rem" }}>
              <div style={{ fontSize: "0.78rem", color: "#666", marginBottom: "0.5rem" }}>
                Sources
              </div>
              {response.citations.map((c) => (
                <details
                  key={c.id}
                  style={{
                    border: "1px solid #eee",
                    borderRadius: "6px",
                    padding: "0.5rem 0.7rem",
                    marginBottom: "0.5rem",
                    background: "#fafafa",
                  }}
                >
                  <summary style={{ cursor: "pointer", fontSize: "0.85rem" }}>
                    <code>{c.id}</code>
                    {c.heading ? ` — ${c.heading}` : ""}
                    {isUrl(c.source) && (
                      <>
                        {" · "}
                        <a href={c.source} target="_blank" rel="noreferrer">
                          open
                        </a>
                      </>
                    )}
                  </summary>
                  <p style={{ marginTop: "0.5rem", fontSize: "0.82rem", color: "#444", lineHeight: 1.5 }}>
                    {c.content.slice(0, 500)}
                    {c.content.length > 500 ? "…" : ""}
                  </p>
                </details>
              ))}
            </div>
          )}

          {response.usage && (
            <p style={{ marginTop: "1rem", fontSize: "0.72rem", color: "#999" }}>
              {response.usage.latencyMs}ms · ${response.usage.costUsd.toFixed(4)} / query
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function isUrl(source: string): boolean {
  return /^https?:\/\//.test(source);
}
