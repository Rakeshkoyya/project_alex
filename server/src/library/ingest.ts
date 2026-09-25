import { extractText, getDocumentProxy } from "unpdf";
import type { Chunk } from "../store/types.js";
import { newId } from "../store/store.js";

/** Pull plain text out of an uploaded file. */
export async function fileToText(buf: Buffer, filename: string, mime?: string): Promise<string> {
  const lower = filename.toLowerCase();
  if (mime === "application/pdf" || lower.endsWith(".pdf")) {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return normalize(Array.isArray(text) ? text.join("\n\n") : text);
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    const { htmlToPage } = await import("./webSearch.js");
    try {
      const p = htmlToPage(buf.toString("utf8"));
      return normalize(p.title ? `# ${p.title}\n\n${p.markdown}` : p.markdown);
    } catch {
      return htmlToText(buf.toString("utf8"));
    }
  }
  return normalize(buf.toString("utf8"));
}

export function htmlToText(html: string): string {
  return normalize(
    html
      .replace(/<(script|style|nav|footer|header|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"'),
  );
}

const normalize = (t: string) => t.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/**
 * Split text into ~target-sized chunks on paragraph boundaries, carrying the
 * nearest heading into each chunk so retrieved passages keep their context.
 */
export function chunkText(resourceId: string, text: string, target = 900): Chunk[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: Chunk[] = [];
  let buf = "";
  let heading = "";
  // Markdown documents: trust '#' headings only. Plain text (e.g. PDFs): short unpunctuated lines.
  const markdown = /^#{1,6}\s/m.test(text);
  const flush = () => {
    if (!buf.trim()) return;
    chunks.push({ id: newId("chk"), resourceId, index: chunks.length, text: (heading && !buf.startsWith(heading) ? `${heading}\n` : "") + buf.trim() });
    buf = "";
  };
  for (let p of paras) {
    const [first, ...rest] = p.split("\n");
    const isHeading = /^#{1,6}\s/.test(first) || (!markdown && first.length < 80 && !/[.?!:]$/.test(first) && !rest.length);
    if (isHeading) {
      // A new section starts a new chunk so passages stay topically coherent.
      flush();
      heading = first.replace(/^#+\s*/, "");
      p = rest.join("\n").trim();
      if (!p) continue;
    }
    if (buf.length + p.length > target) flush();
    if (p.length > target * 1.5) {
      for (let i = 0; i < p.length; i += target) {
        buf = p.slice(i, i + target);
        flush();
      }
      continue;
    }
    buf += (buf ? "\n\n" : "") + p;
  }
  flush();
  return chunks;
}
