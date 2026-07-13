import { ImageResponse } from "next/og";

// Next.js renders this at build time into og:image / twitter:image (absolute URL
// resolved via metadataBase). Self-contained — no external fonts or assets, so it
// works under the deployment's strict environment.
export const alt =
  "Mimir — a grounded RAG knowledge base that cites its sources and refuses when it doesn't know.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#1e293b",
          padding: "72px 80px",
          color: "#ece3ce",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "28px" }}>
          <svg width="96" height="96" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="7" fill="#0f172a" />
            <g
              stroke="#ece3ce"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            >
              <path d="M8.5 8 V20" />
              <path d="M23.5 8 V20" />
              <path d="M8.5 8 L16 15.5 L23.5 8" />
              <path d="M8 24.5 Q16 27.4 24 24.5" stroke="#7dd3c0" strokeWidth="2" />
            </g>
          </svg>
          <div style={{ fontSize: "104px", fontWeight: 700, letterSpacing: "-2px" }}>
            Mimir
          </div>
        </div>

        <div style={{ display: "flex", fontSize: "46px", lineHeight: 1.25, maxWidth: "980px" }}>
          A grounded RAG knowledge base that cites its sources — and refuses when it
          doesn&rsquo;t know.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
          <div
            style={{
              display: "flex",
              alignSelf: "flex-start",
              padding: "12px 22px",
              borderRadius: "10px",
              background: "#0f172a",
              color: "#7dd3c0",
              fontSize: "30px",
            }}
          >
            &ldquo;Not in the knowledge base.&rdquo;
          </div>
          <div style={{ display: "flex", fontSize: "28px", color: "#94a3b8" }}>
            OpenAI embeddings · Postgres + pgvector · Claude · measured eval
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
