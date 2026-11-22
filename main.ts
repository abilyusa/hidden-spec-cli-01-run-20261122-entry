// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does all ten
// sections of SPEC.md: the command line, the output and exit codes, safe paths, format detection, line matching at
// three tiers, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and the all-or-nothing write.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 3: a file's lines, its line break and its final line break. */
/* ------------------------------------------------------------------ */

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/* --------------------------------------------------- */
/* Section 5: matching lines at three tiers.           */
/* --------------------------------------------------- */

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions i where O's lines match the file's lines i, i+1, ... at this tier. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(O[k]!, lines[i + k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once at or after `from`, with its positions. */
function findTier(O: string[], lines: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: its text, and the index into O when it is a context line (else null). */
interface NLine {
  text: string;
  oIndex: number | null;
}

/**
 * Replace lines[at .. at+O.length) by N. A context line is written as the file's own matched line; at tier 2
 * every other line of N that is not empty or only whitespace and starts with P (the leading spaces and tabs of
 * O's first line) has that P replaced by F (those of the file's first matched line).
 */
function spliceLines(lines: string[], at: number, O: string[], N: NLine[], tier: number): string[] {
  const F = leadWs(lines[at] ?? '');
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  const built = N.map((nl) => {
    if (nl.oIndex !== null) return lines[at + nl.oIndex]!;
    if (tier === 2 && !/^[ \t]*$/.test(nl.text) && nl.text.startsWith(P)) return F + nl.text.slice(P.length);
    return nl.text;
  });
  return [...lines.slice(0, at), ...built, ...lines.slice(at + O.length)];
}

/* ------------------------------------------------------------------ */
/* Shared hunk/chunk body reading (sections 6 and 8).                 */
/* ------------------------------------------------------------------ */

interface Hunk {
  A: number;
  O: string[];
  N: NLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noEol: boolean;
  /** a `\` line follows the hunk's last `+` line */
  plusNoEol: boolean;
}

/** O and N of a hunk/chunk body, in body order. */
function bodyON(body: string[]): { O: string[]; N: NLine[]; noEol: boolean; plusNoEol: boolean } {
  const O: string[] = [];
  const N: NLine[] = [];
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  body.forEach((l, j) => {
    if (l.startsWith(' ') || l === '') {
      const text = l === '' ? '' : l.slice(1);
      O.push(text);
      N.push({ text, oIndex: O.length - 1 });
      lastCtxOrPlus = j;
    } else if (l.startsWith('-')) {
      O.push(l.slice(1));
    } else if (l.startsWith('+')) {
      N.push({ text: l.slice(1), oIndex: null });
      lastCtxOrPlus = j;
      lastPlus = j;
    }
    // a `\` line refers to the body line before it and adds nothing to O or N.
  });
  const noEol = lastCtxOrPlus >= 0 && lastCtxOrPlus + 1 < body.length && body[lastCtxOrPlus + 1]!.startsWith('\\');
  const plusNoEol = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\');
  return { O, N, noEol, plusNoEol };
}

/** Apply hunks in order to a file's text (section 6), tracking the final line break. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const { lines: origLines, br, final: origFinal } = splitFile(before);
  let lines = [...origLines];
  let finalBreak = origFinal;
  let d = 0;
  for (const h of hunks) {
    if (h.O.length > 0) {
      const found = findTier(h.O, lines, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.occ[0]!;
      for (const pos of found.occ) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const at = best;
      const runsToEnd = at + h.O.length === lines.length;
      lines = spliceLines(lines, at, h.O, h.N, found.tier);
      if (runsToEnd) finalBreak = !h.noEol;
      d += h.N.length - h.O.length;
    } else {
      const pos = Math.min(h.A + d, lines.length);
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...h.N.map((nl) => nl.text), ...lines.slice(pos)];
      if (atEnd) finalBreak = !h.noEol;
      d += h.N.length;
    }
  }
  return joinFile(lines, br, finalBreak);
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                         */
/* ------------------------------------------------------------------ */

function parseUnifiedPath(s: string): string {
  let t = s.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function stripAB(p: string): string {
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The body of a hunk: body lines from `start`, stopping at the first other line. */
function parseHunkBody(lines: string[], start: number): { body: string[]; end: number } {
  const body: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
      body.push(l);
      j++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, end: j };
}

interface UniSection {
  pairOld?: string;
  pairNew?: string;
  renameFrom?: string;
  renameTo?: string;
  diffOld?: string;
  diffNew?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function uniSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldPath = s.pairOld ?? s.renameFrom ?? s.diffOld;
  const newPath = s.pairNew ?? s.renameTo ?? s.diffNew;
  const oldP = oldPath === '/dev/null' ? null : (oldPath ?? null);
  const newP = newPath === '/dev/null' ? null : (newPath ?? null);
  if (oldP === null || s.create) {
    const target = newP ?? '';
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      let plusNoEol = false;
      for (const h of s.hunks) {
        if (h.N.some((nl) => nl.oIndex === null)) plusNoEol = h.plusNoEol;
        for (const nl of h.N) if (nl.oIndex === null) plus.push(nl.text);
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (plusNoEol ? '' : '\n'));
    };
  }
  if (newP === null || s.del) {
    const target = oldP ?? '';
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldP !== newP) {
    const from = oldP;
    const to = newP;
    return (tree) => {
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const before = tree.get(from);
      if (before === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const after = applyHunks(before, s.hunks, strict, from);
      tree.now.set(from, null);
      tree.now.set(to, after);
      tree.moves.push({ old: from, new: to });
    };
  }
  const target = oldP;
  return (tree) => {
    if (!safe(target)) throw new Fail('unsafe', target);
    const before = tree.get(target);
    if (before === null) throw new Fail('missing', target);
    tree.now.set(target, applyHunks(before, s.hunks, strict, target));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const startSection = (): UniSection => {
    const s: UniSection = { create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(m[1]!, 10);
      const { body, end } = parseHunkBody(lines, i + 1);
      const { O, N, noEol, plusNoEol } = bodyON(body);
      cur.hunks.push({ A, O, N, noEol, plusNoEol });
      inHeader = false;
      i = end;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = stripAB(parseUnifiedPath(l));
      const newP = stripAB(parseUnifiedPath(lines[i + 1]!));
      if (cur !== null && inHeader && cur.pairOld === undefined && cur.pairNew === undefined) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
      } else {
        const s = startSection();
        s.pairOld = oldP;
        s.pairNew = newP;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && inHeader) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (cur !== null && inHeader && l.startsWith('rename from ')) {
      cur.renameFrom = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('rename to ')) {
      cur.renameTo = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('new file mode')) {
      cur.create = true;
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('deleted file mode')) {
      cur.del = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => uniSectionEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                 */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  if (oldLines.length === 0) {
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
    };
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(before);
    const found = findTier(oldLines, lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const N = newLines.map((t): NLine => ({ text: t, oIndex: null }));
    const out = spliceLines(lines, at, oldLines, N, found.tier);
    tree.now.set(path, joinFile(out, br, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | null = null;
      for (let j = s - 1; j > prevEnd; j--) {
        const cand = lines[j]!;
        if (blank(cand)) continue;
        if (cand.trim().startsWith('```')) continue;
        path = cand.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
        path = prevPath;
      }
      let sep = -1;
      for (let j = s + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          sep = j;
          break;
        }
      }
      if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
      let end = -1;
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
      if (end < 0) throw new Exit2(`error: parse ${s + 1}`);
      edits.push(searchReplaceEdit(path, lines.slice(s + 1, sep), lines.slice(sep + 1, end), strict));
      prevPath = path;
      prevEnd = end;
      i = end + 1;
      continue;
    }
    i++;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                           */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  O: string[];
  N: NLine[];
  eof: boolean;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { lines: origLines, br, final } = splitFile(before);
    let lines = [...origLines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier([ch.anchor], lines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      if (ch.O.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, pos), ...ch.N.map((nl) => nl.text), ...lines.slice(pos)];
        cursor = pos + ch.N.length;
        continue;
      }
      const found = findTier(ch.O, lines, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let at: number | undefined;
      if (ch.eof) {
        at = found.occ.find((pos) => pos + ch.O.length === lines.length);
        if (at === undefined) throw new Fail('no-match', path);
      } else {
        at = found.occ[0]!;
      }
      lines = spliceLines(lines, at, ch.O, ch.N, found.tier);
      cursor = at + ch.N.length;
    }
    const after = joinFile(lines, br, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, after);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, after);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const secLines: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        secLines.push(lines[j]!);
        j++;
      }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
      for (let k = 0; k < secLines.length; k++) {
        const sl = secLines[k]!;
        if (sl === '' || sl.startsWith('+')) continue;
        throw new Exit2(`error: parse ${i + 1 + k + 1}`);
      }
      const fileLines = secLines.map((sl) => (sl === '' ? '' : sl.slice(1)));
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      // Collect the section's lines, then drop blank lines at its end.
      const secStart = j; // 0-based index of secLines[0]: after the Update File line and any Move to line.
      const secLines: string[] = [];
      while (j < last && !isSectionStart(lines[j]!)) {
        secLines.push(lines[j]!);
        j++;
      }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
      const chunks: V4aChunk[] = [];
      let curChunk: { anchor: string | null; body: string[]; eof: boolean } | null = null;
      const flushChunk = (): void => {
        if (curChunk === null) return;
        const { O, N } = bodyON(curChunk.body);
        chunks.push({ anchor: curChunk.anchor, O, N, eof: curChunk.eof });
        curChunk = null;
      };
      for (let k = 0; k < secLines.length; k++) {
        const m = secLines[k]!;
        if (m.startsWith('@@')) {
          flushChunk();
          const anchor = m.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          continue;
        }
        if (m.trim() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${secStart + k + 1}`);
          curChunk.eof = true;
          flushChunk();
          continue;
        }
        if (m.startsWith(' ') || m.startsWith('-') || m.startsWith('+') || m === '') {
          if (curChunk === null) {
            // SPEC section 8: a chunk starts at an `@@` line or, for the first chunk, at a body line.
            // Once a chunk has ended (at `*** End of File`, or flushed by a later `@@`), a body line
            // cannot start another chunk, so it is a parse error. The old code silently opened a new
            // implicit chunk here; a blank line after `*** End of File` then became a phantom chunk
            // matching one empty line, which could fail the whole edit with `no-match` even though the
            // patch was otherwise fine.
            if (chunks.length > 0) throw new Exit2(`error: parse ${secStart + k + 1}`);
            curChunk = { anchor: null, body: [], eof: false };
          }
          curChunk.body.push(m);
          continue;
        }
        throw new Exit2(`error: parse ${secStart + k + 1}`);
      }
      flushChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits.                                            */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Sections 1, 2 and 10: invocation, output and atomicity.           */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows, in byte order of the paths (a move's R line sorts by its new path and replaces that pair's D/A).
  const rOlds = new Set<string>();
  const rNews = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.new) === null && tree.now.get(m.new) !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      rOlds.add(m.old);
      rNews.add(m.new);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (rOlds.has(p) || rNews.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
