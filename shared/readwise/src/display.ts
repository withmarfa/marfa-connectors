import { Lexer, type Token, type Tokens } from "marked";

/** Readwise cuts a highlight's text at this many characters. */
export const readwisePassageLimit = 8_191;
const titleLength = 80;

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
function decoded(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]+));/g,
    (whole, decimal?: string, hex?: string, name?: string) => {
      const point =
        decimal !== undefined
          ? Number(decimal)
          : hex !== undefined
            ? Number.parseInt(hex, 16)
            : undefined;
      if (point !== undefined)
        return point > 0 &&
          point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point)
          : whole;
      return (name === undefined ? undefined : entities[name]) ?? whole;
    },
  );
}
function untagged(html: string): string {
  return decoded(html.replace(/<[^>]*>/g, " "));
}

interface Reading {
  lines: string[];
  picture: boolean;
}
function inline(
  tokens: readonly Token[] | undefined,
  reading: Reading,
): string {
  let text = "";
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "image":
        reading.picture = true;
        break;
      case "html":
        if (/<img\b/i.test((token as Tokens.HTML).text)) reading.picture = true;
        break;
      case "br":
        text += "\n";
        break;
      case "codespan":
      case "escape":
        text += decoded((token as Tokens.Codespan).text);
        break;
      case "text":
        text +=
          "tokens" in token
            ? inline(token.tokens, reading)
            : decoded((token as Tokens.Text).text);
        break;
      default:
        if ("tokens" in token && Array.isArray(token.tokens))
          text += inline(token.tokens, reading);
        else if ("text" in token && typeof token.text === "string")
          text += decoded(token.text);
    }
  }
  return text;
}
function blocks(tokens: readonly Token[], reading: Reading): void {
  const line = (text: string) => reading.lines.push(text);
  for (const token of tokens) {
    switch (token.type) {
      case "space":
      case "hr":
      case "def":
        break;
      case "blockquote":
        blocks((token as Tokens.Blockquote).tokens, reading);
        break;
      case "list":
        for (const item of (token as Tokens.List).items)
          blocks(item.tokens, reading);
        break;
      case "table": {
        const table = token as Tokens.Table;
        for (const row of [table.header, ...table.rows])
          line(row.map((cell) => inline(cell.tokens, reading)).join(" "));
        break;
      }
      case "code":
        line((token as Tokens.Code).text);
        break;
      case "html":
        if (/<img\b/i.test((token as Tokens.HTML).text)) reading.picture = true;
        line(untagged((token as Tokens.HTML).text));
        break;
      default:
        line(
          "tokens" in token && Array.isArray(token.tokens)
            ? inline(token.tokens, reading)
            : "text" in token && typeof token.text === "string"
              ? decoded(token.text)
              : "",
        );
    }
  }
}
function read(markdown: string): Reading {
  const reading: Reading = { lines: [], picture: false };
  blocks(Lexer.lex(markdown, { gfm: true }), reading);
  reading.lines = reading.lines
    .flatMap((text) => text.split("\n"))
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return reading;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** At most 80 characters, cut back to a word boundary, with an ellipsis. */
export function shortened(text: string): string {
  const whole = text.replace(/\s+/g, " ").trim();
  const parts = [...graphemes.segment(whole)].map(({ segment }) => segment);
  if (parts.length <= titleLength) return whole;
  const kept = parts.slice(0, titleLength - 1).join("");
  const space = kept.lastIndexOf(" ");
  // A long word is cut where it is, rather than leaving a stub of a title.
  const cut = space >= kept.length / 2 ? kept.slice(0, space) : kept;
  return `${cut.replace(/[\s,;:]+$/u, "")}…`;
}

export interface HighlightDisplay {
  title: string;
  body: string | undefined;
}
/**
 * The title and body a highlight shows. The body is the passage as Markdown,
 * whole: the export passage keeps pictures and formatting that Reader's plain
 * passage drops, unless Readwise cut it at its limit. The title is the first
 * line of the plain passage, or names the picture or highlight when the
 * passage has no words.
 */
export function highlightDisplay(
  text: string,
  exportText: unknown,
  documentTitle: string | null | undefined,
  previous: Readonly<Record<string, unknown>> = {},
): HighlightDisplay {
  const marked =
    typeof exportText === "string" &&
    exportText.trim() !== "" &&
    (exportText.length < readwisePassageLimit || text.trim() === "")
      ? exportText
      : text;
  const body = marked.trim() === "" ? undefined : marked;
  const plain = read(text);
  const rich = body === undefined || body === text ? plain : read(body);
  const first = plain.lines[0] ?? rich.lines[0];
  if (first !== undefined) return { title: shortened(first), body };
  const word = plain.picture || rich.picture ? "Picture" : "Highlight";
  const named = documentTitle?.replace(/\s+/g, " ").trim();
  if (named) return { title: shortened(`${word} from ${named}`), body };
  // Without the document's title, a caller keeps the one a fuller caller set.
  const kept = previous["title"];
  return {
    title:
      typeof kept === "string" &&
      kept.startsWith(word) &&
      previous["body"] === body
        ? kept
        : word,
    body,
  };
}
