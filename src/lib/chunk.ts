import crypto from "crypto";

export interface Chunk {
  /** Stable chunk id: "<source>#<index>" — this is what answers cite. */
  id: string;
  source: string;
  heading: string | null;
  content: string;
  /**
   * What actually gets embedded: source + heading prefixed to the content.
   * The context prefix makes detail-heavy chunks (SQL, numbers) retrievable
   * by topic, not just by their literal wording.
   */
  embeddingInput: string;
  /** sha256 of embeddingInput — the idempotency key for ingest. */
  hash: string;
}

/** Target ceiling per chunk, in characters (~400 tokens). */
const MAX_CHUNK_CHARS = 1600;

/**
 * Splits a markdown document into chunks along heading boundaries,
 * then splits oversized sections by paragraph. Chunk ids are positional
 * ("docs/faq.md#2"), content hashes make re-ingestion idempotent.
 */
export function chunkMarkdown(source: string, markdown: string): Chunk[] {
  const sections = splitByHeadings(markdown);
  const pieces: { heading: string | null; content: string }[] = [];

  for (const section of sections) {
    if (section.content.length <= MAX_CHUNK_CHARS) {
      pieces.push(section);
    } else {
      for (const part of splitByParagraphs(section.content)) {
        pieces.push({ heading: section.heading, content: part });
      }
    }
  }

  return pieces
    .filter((p) => p.content.trim().length > 40)
    .map((p, index) => {
      const content = p.content.trim();
      const embeddingInput = `${source}${p.heading ? ` — ${p.heading}` : ""}\n\n${content}`;
      return {
        id: `${source}#${index}`,
        source,
        heading: p.heading,
        content,
        embeddingInput,
        hash: crypto.createHash("sha256").update(embeddingInput).digest("hex"),
      };
    });
}

function splitByHeadings(markdown: string): { heading: string | null; content: string }[] {
  const lines = markdown.split("\n");
  const sections: { heading: string | null; content: string }[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content) sections.push({ heading, content });
    buffer = [];
  };

  for (const line of lines) {
    const match = /^#{1,3}\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[1].trim();
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

function splitByParagraphs(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const parts: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
      parts.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Converts an HTML page into markdown-ish plain text so it can go through
 * the same chunker as local files. Deliberately dependency-free: headings,
 * list items and paragraphs are preserved, everything else is stripped.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => `\n\n${"#".repeat(Number(level))} ${stripTags(text)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, text) => `\n- ${stripTags(text)}`)
    .replace(/<(p|div|section|article|br|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
