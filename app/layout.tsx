import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Mimir — grounded RAG knowledge base",
  description: "Cited answers from your documents. Honest refusals for everything else.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-monospace, monospace", margin: "3rem auto", maxWidth: "42rem", padding: "0 1rem" }}>
        {children}
      </body>
    </html>
  );
}
