import type { Metadata } from "next";
import type { ReactNode } from "react";

const description =
  "A grounded RAG knowledge base that cites its sources — and refuses when it doesn't know. Cited answers from your documents, honest refusals for everything else.";

export const metadata: Metadata = {
  metadataBase: new URL("https://mimir-five-bice.vercel.app"),
  title: "Mimir — grounded RAG knowledge base",
  description,
  applicationName: "Mimir",
  authors: [{ name: "Andrew Rozumny" }],
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Mimir",
    title: "Mimir — grounded RAG knowledge base",
    description,
  },
  twitter: {
    card: "summary_large_image",
    title: "Mimir — grounded RAG knowledge base",
    description,
  },
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
