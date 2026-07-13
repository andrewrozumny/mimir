export default function Home() {
  return (
    <main>
      <h1>Mimir</h1>
      <p>
        A grounded RAG knowledge base. Answers come only from the ingested corpus, with inline
        citations to source chunks — and an honest “Not in the knowledge base.” when the answer
        isn’t there.
      </p>
      <p>Ask it something over HTTP:</p>
      <pre style={{ background: "#f4f4f4", padding: "1rem", overflowX: "auto" }}>
        {`curl -s localhost:3000/api/chat \\
  -H 'content-type: application/json' \\
  -d '{"question": "What is Mimir?"}'`}
      </pre>
      <p>Chat widget coming next — see the README roadmap.</p>
    </main>
  );
}
