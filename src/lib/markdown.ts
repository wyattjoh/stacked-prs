import * as colors from "@std/fmt/colors";
import stringWidth from "string-width";

/**
 * One styled run of inline markdown text.
 */
export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  underline?: boolean;
  url?: string;
}

/**
 * Parsed markdown block supported by branch descriptions.
 */
export type MdBlock =
  | { kind: "paragraph"; spans: MdSpan[] }
  | { kind: "list"; items: MdSpan[][] };

const INLINE_RE =
  /(\*\*([^*\n]+)\*\*)|(\*([^*\s][^*\n]*?)\*)|(`([^`\n]+)`)|((?<!\!)\[([^\]\n]+)\]\(([^)\s]+)\))/;

/**
 * Parse supported inline markdown forms into styled spans.
 *
 * Unsupported or unmatched syntax is returned as literal text.
 *
 * @param text Raw inline markdown text.
 * @returns Styled spans for the supported inline subset.
 */
export function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let rest = text;
  while (rest.length > 0) {
    const match = rest.match(INLINE_RE);
    if (!match || match.index === undefined) {
      spans.push({ text: rest });
      break;
    }

    if (match.index > 0) spans.push({ text: rest.slice(0, match.index) });
    if (match[2] !== undefined) spans.push({ text: match[2], bold: true });
    else if (match[4] !== undefined) {
      spans.push({ text: match[4], italic: true });
    } else if (match[6] !== undefined) {
      spans.push({ text: match[6], code: true });
    } else {
      spans.push({ text: match[8], url: match[9] });
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return spans;
}

/**
 * Parse the supported markdown block subset.
 *
 * Consecutive non-empty non-list lines become one paragraph with soft wraps
 * collapsed to spaces. Flat `-` and `*` list items become list blocks.
 *
 * @param source Raw markdown source.
 * @returns Parsed paragraph and flat-list blocks.
 */
export function parseMarkdown(source: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let list: MdSpan[][] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({
      kind: "paragraph",
      spans: parseInline(paragraph.join(" ")),
    });
    paragraph = [];
  };

  const flushList = () => {
    if (list === null) return;
    blocks.push({ kind: "list", items: list });
    list = null;
  };

  for (const raw of source.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else if (bullet) {
      flushParagraph();
      list = list ?? [];
      list.push(parseInline(bullet[1]));
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

/**
 * Return the first non-empty line from raw markdown source.
 *
 * @param source Raw markdown source.
 * @returns The trimmed first non-empty source line, or an empty string.
 */
export function firstLine(source: string): string {
  for (const line of source.split("\n")) {
    if (line.trim() !== "") return line.trim();
  }
  return "";
}

/**
 * Flatten inline markdown to plain text.
 *
 * Link spans become `text (url)`.
 *
 * @param text Raw inline markdown text.
 * @returns Plain text with link targets preserved in parentheses.
 */
export function stripInline(text: string): string {
  return parseInline(text)
    .map((span) =>
      span.url !== undefined ? `${span.text} (${span.url})` : span.text
    )
    .join("");
}

function spanToAnsi(span: MdSpan, dim: boolean): string {
  let text = span.text;
  if (span.url !== undefined) text = `${colors.underline(text)} (${span.url})`;
  if (span.underline) text = colors.underline(text);
  if (span.code) text = colors.cyan(text);
  if (span.bold) text = colors.bold(text);
  if (span.italic) text = colors.italic(text);
  return dim ? colors.dim(text) : text;
}

/**
 * Render inline markdown to ANSI-styled text.
 *
 * @param text Raw inline markdown text.
 * @param opts Rendering options.
 * @returns ANSI-styled terminal text.
 */
export function renderInlineAnsi(
  text: string,
  opts: { dim?: boolean } = {},
): string {
  return parseInline(text)
    .map((span) => spanToAnsi(span, opts.dim === true))
    .join("");
}

function sameStyle(a: MdSpan, b: MdSpan): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code &&
    a.underline === b.underline && a.url === b.url;
}

function appendSpan(line: MdSpan[], span: MdSpan): void {
  if (span.text.length === 0) return;
  const previous = line[line.length - 1];
  if (previous && sameStyle(previous, span)) {
    previous.text += span.text;
  } else {
    line.push({ ...span });
  }
}

function wordSpans(spans: MdSpan[]): MdSpan[] {
  const words: MdSpan[] = [];
  for (const span of spans) {
    if (span.url !== undefined) {
      for (const word of span.text.split(/\s+/)) {
        if (word) words.push({ text: word, underline: true });
      }
      words.push({ text: `(${span.url})` });
      continue;
    }
    const { text: _text, ...style } = span;
    for (const word of span.text.split(/\s+/)) {
      if (word) words.push({ ...style, text: word });
    }
  }
  return words;
}

function splitSpanToWidth(span: MdSpan, width: number): MdSpan[] {
  if (stringWidth(span.text) <= width) return [span];

  const chunks: MdSpan[] = [];
  let text = "";
  let used = 0;
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    .segment(span.text);
  for (const { segment } of graphemes) {
    const segmentWidth = stringWidth(segment);
    if (text.length > 0 && used + segmentWidth > width) {
      chunks.push({ ...span, text });
      text = "";
      used = 0;
    }
    text += segment;
    used += segmentWidth;
  }
  if (text.length > 0) chunks.push({ ...span, text });
  return chunks;
}

function wrapSpans(spans: MdSpan[], width: number): MdSpan[][] {
  const words = wordSpans(spans);
  if (words.length === 0) return [[{ text: "" }]];

  const lines: MdSpan[][] = [];
  let line: MdSpan[] = [];
  let used = 0;

  for (const word of words) {
    const wordWidth = stringWidth(word.text);
    const needed = used + (line.length === 0 ? 0 : 1) + wordWidth;
    if (line.length > 0 && needed > width) {
      lines.push(line);
      line = [];
      used = 0;
    }

    if (wordWidth <= width) {
      if (line.length > 0) {
        appendSpan(line, { text: " " });
        used += 1;
      }
      appendSpan(line, word);
      used += wordWidth;
      continue;
    }

    for (const chunk of splitSpanToWidth(word, width)) {
      if (line.length > 0) lines.push(line);
      line = [chunk];
      used = stringWidth(chunk.text);
    }
  }

  if (line.length > 0) lines.push(line);
  return lines;
}

/**
 * Layout markdown as styled span lines wrapped to `width` columns.
 *
 * Blank lines between blocks are represented by empty arrays. Bullet prefixes
 * are included as plain spans at the beginning of each item line.
 *
 * @param source Raw markdown source.
 * @param width Maximum terminal display width in columns.
 * @returns Styled span lines wrapped to the requested display width.
 */
export function wrapMarkdown(source: string, width: number): MdSpan[][] {
  const lines: MdSpan[][] = [];
  const safeWidth = Math.max(1, width);
  const blocks = parseMarkdown(source);

  blocks.forEach((block, index) => {
    if (index > 0) lines.push([]);
    if (block.kind === "paragraph") {
      lines.push(...wrapSpans(block.spans, safeWidth));
      return;
    }

    for (const item of block.items) {
      wrapSpans(item, Math.max(1, safeWidth - 2)).forEach(
        (wrapped, itemIndex) => {
          lines.push([{ text: itemIndex === 0 ? "• " : "  " }, ...wrapped]);
        },
      );
    }
  });
  return lines;
}

/**
 * Render markdown as ANSI-styled lines wrapped to `width` columns.
 *
 * @param source Raw markdown source.
 * @param width Maximum terminal display width in columns.
 * @param opts Rendering options.
 * @returns ANSI-styled terminal lines.
 */
export function renderAnsiLines(
  source: string,
  width: number,
  opts: { dim?: boolean } = {},
): string[] {
  const dim = opts.dim === true;
  return wrapMarkdown(source, width).map((line) =>
    line.map((span) => spanToAnsi(span, dim)).join("")
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function spanToHtml(span: MdSpan): string {
  let html = escapeHtml(span.text);
  if (span.code) html = `<code>${html}</code>`;
  if (span.bold) html = `<strong>${html}</strong>`;
  if (span.italic) html = `<em>${html}</em>`;
  if (span.url !== undefined) {
    if (/^https?:\/\//i.test(span.url)) {
      html = `<a href="${
        escapeHtml(span.url)
      }" target="_blank" rel="noopener">${html}</a>`;
    } else {
      html = `${html} (${escapeHtml(span.url)})`;
    }
  }
  return html;
}

/**
 * Render markdown to escaped HTML for the serve UI.
 *
 * @param source Raw markdown source.
 * @returns Escaped HTML containing only the supported markdown subset.
 */
export function renderHtml(source: string): string {
  return parseMarkdown(source)
    .map((block) =>
      block.kind === "paragraph"
        ? `<p>${block.spans.map(spanToHtml).join("")}</p>`
        : `<ul>${
          block.items
            .map((item) => `<li>${item.map(spanToHtml).join("")}</li>`)
            .join("")
        }</ul>`
    )
    .join("");
}
