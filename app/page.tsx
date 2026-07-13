import AskWidget from "./AskWidget";

export default function Home() {
  return (
    <main>
      <h1 style={{ marginBottom: "0.25rem" }}>Mimir</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        A grounded RAG knowledge base. Answers come only from the ingested corpus, with citations to
        the source chunks — and an honest “Not in the knowledge base.” when the answer isn’t there.
      </p>
      <p style={{ color: "#555" }}>
        This demo is loaded with Mimir’s own documentation — ask it about itself. Ask something
        off-topic and watch it refuse instead of guessing.
      </p>

      <AskWidget />

      <hr style={{ margin: "2.5rem 0 1.25rem", border: "none", borderTop: "1px solid #eee" }} />
      <p style={{ fontSize: "0.8rem", color: "#999" }}>
        Config-driven corpus · OpenAI embeddings · Postgres + pgvector · Claude ·{" "}
        <a href="https://github.com/andrewrozumny/mimir">source on GitHub</a>
      </p>
    </main>
  );
}
