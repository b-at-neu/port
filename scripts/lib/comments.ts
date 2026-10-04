// Pure character-level comment scanner: finds the citation lines and
// over-long comment blocks the "Comment ratchet" check rates against each
// area's ceiling. No I/O and no imports, so it type-strips standalone and a
// later sweep can reuse it without pulling in the rest of scripts/lib/.

const OPERATOR_CHARS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^',
]);
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await',
]);

const BARE_CITATION_RE = /(?<![\w&])#(\d+)\b/g;
const ISSUE_PHRASE_RE = /\b(?:issues?|pull requests?)\s+#?\d+/i;
const PR_PHRASE_RE = /\bPRs?\s+#?\d+/i;

/** Whether a line's comment text (not its code) cites a ticket. `#0` is this
 *  repository's own "no issue" sentinel, never a citation. */
function hasCitation(commentText: string): boolean {
  for (const m of commentText.matchAll(BARE_CITATION_RE)) {
    if (m[1] !== '0') return true;
  }
  return ISSUE_PHRASE_RE.test(commentText) || PR_PHRASE_RE.test(commentText);
}

/** A line with every `/`, `*`, and whitespace stripped — what is left once
 *  the delimiters themselves are removed. */
function strippedContent(line: string): string {
  return line.replace(/[/*\s]/g, '');
}

type State = 'code' | 'line-comment' | 'block-comment' | 'string' | 'template' | 'regex';

export interface ScanResult {
  /** 1-based line numbers citing a ticket, pull request, or issue number. */
  citationLines: number[];
  /** 1-based start line of every comment block over two content lines. */
  longBlocks: number[];
}

/** Scans one file's already-read source for the two things the comment
 *  ratchet rates. A character-level state machine, not a regex sweep over
 *  the raw text — a string, template, or regex literal that merely contains
 *  `//`, `/*`, or a `#N`-looking substring must never read as a real
 *  comment. No I/O: the caller reads the file, this only classifies text. */
export function scanComments(text: string): ScanResult {
  const lines = text.split('\n');
  const citationLines: number[] = [];
  const longBlocks: number[] = [];

  let state: State = 'code';
  let stringQuote = '';
  let inCharClass = false;
  // One entry per open `${…}` interpolation, holding that interpolation's
  // own unmatched `{` count — what tells its closing `}` apart from a
  // nested object literal's.
  const templateDepth: number[] = [];
  let lastChar: string | undefined;
  let lastWord: string | undefined;
  let currentWord = '';
  let atStart = true;

  let blockStart: number | null = null;
  let blockContentLines = 0;

  const endBlock = () => {
    if (blockStart !== null && blockContentLines > 2) longBlocks.push(blockStart);
    blockStart = null;
    blockContentLines = 0;
  };
  const flushWord = () => {
    if (currentWord !== '') {
      lastWord = currentWord;
      currentWord = '';
    }
  };
  const exitLiteral = (closingChar: string) => {
    state = 'code';
    lastChar = closingChar;
    lastWord = undefined;
    atStart = false;
  };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNo = lineIdx + 1;
    const stateAtLineStart = state;
    let hasCode = false;
    let commentChars = 0;
    let commentText = '';

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];

      if (state === 'line-comment') {
        commentChars++;
        commentText += ch;
        continue;
      }

      if (state === 'block-comment') {
        commentChars++;
        commentText += ch;
        if (ch === '*' && next === '/') {
          commentText += next;
          commentChars++;
          i++;
          state = 'code';
        }
        continue;
      }

      if (state === 'string') {
        hasCode = true;
        if (ch === '\\') { i++; continue; }
        if (ch === stringQuote) exitLiteral(ch);
        continue;
      }

      if (state === 'template') {
        hasCode = true;
        if (ch === '\\') { i++; continue; }
        if (ch === '`') { exitLiteral(ch); continue; }
        if (ch === '$' && next === '{') {
          templateDepth.push(0);
          state = 'code';
          i++;
          continue;
        }
        continue;
      }

      if (state === 'regex') {
        hasCode = true;
        if (ch === '\\') { i++; continue; }
        if (ch === '[') inCharClass = true;
        else if (ch === ']') inCharClass = false;
        else if (ch === '/' && !inCharClass) exitLiteral(ch);
        continue;
      }

      // state === 'code'
      if (ch === '/' && next === '/') {
        state = 'line-comment';
        commentChars += 2;
        commentText += '//';
        i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block-comment';
        commentChars += 2;
        commentText += '/*';
        i++;
        continue;
      }
      if (ch === '/') {
        const isRegexStart =
          atStart ||
          (lastChar !== undefined && OPERATOR_CHARS.has(lastChar)) ||
          (lastWord !== undefined && REGEX_KEYWORDS.has(lastWord));
        hasCode = true;
        flushWord();
        if (isRegexStart) {
          state = 'regex';
          inCharClass = false;
        }
        lastChar = ch;
        atStart = false;
        continue;
      }
      if (ch === "'" || ch === '"') {
        state = 'string';
        stringQuote = ch;
        hasCode = true;
        lastChar = ch;
        lastWord = undefined;
        atStart = false;
        flushWord();
        continue;
      }
      if (ch === '`') {
        state = 'template';
        hasCode = true;
        lastChar = ch;
        lastWord = undefined;
        atStart = false;
        flushWord();
        continue;
      }
      if (templateDepth.length > 0 && (ch === '{' || ch === '}')) {
        const top = templateDepth.length - 1;
        if (ch === '{') {
          templateDepth[top]++;
        } else if (templateDepth[top] === 0) {
          templateDepth.pop();
          state = 'template';
          hasCode = true;
          continue;
        } else {
          templateDepth[top]--;
        }
      }
      if (/\s/.test(ch)) {
        flushWord();
        continue; // whitespace is never "significant"
      }
      hasCode = true;
      if (/[A-Za-z0-9_$]/.test(ch)) {
        currentWord += ch;
      } else {
        flushWord();
      }
      lastChar = ch;
      atStart = false;
    }

    // Strings and regexes never cross a physical line in this scanner's own
    // model (`'`/`"`/regex "end at the closing quote or the end of the
    // line" — a template literal is the one exception, and a block comment
    // or line comment are expected to continue or reset on their own terms).
    if (state === 'string' || state === 'regex') state = 'code';
    if (state === 'line-comment') state = 'code';
    flushWord();

    if (hasCitation(commentText)) citationLines.push(lineNo);

    const isCommentOnly = !hasCode && (commentChars > 0 || stateAtLineStart === 'block-comment');
    if (isCommentOnly) {
      if (blockStart === null) blockStart = lineNo;
      if (strippedContent(line).length > 0) blockContentLines++;
    } else {
      endBlock();
    }
  }
  endBlock();

  return { citationLines, longBlocks };
}
