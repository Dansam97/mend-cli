// main.ts is mend, the CLI SPEC.md specifies. It began from the kit's starting point (MIT): the command line,
// the output and exit codes, safe paths, format detection, JSON edits and the all-or-nothing write were there;
// the three text formats (unified diffs, SEARCH/REPLACE blocks, V4A patches) and the three-tier line matching
// of section 5 are implemented here from SPEC.md. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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
  /** Successful moves, in the order their edits ran: [old path, new path]. */
  readonly moves: [string, string][] = [];
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

/* ------------------------------------------------------------------ */
/* Section 3: a file as lines, its own line break and its final break */
/* ------------------------------------------------------------------ */

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function serialize(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/* ---------------------------------------------------- */
/* Section 5: finding old lines at the first tier that  */
/* has an occurrence, and writing the new lines there   */
/* ---------------------------------------------------- */

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

interface Found {
  tier: number;
  positions: number[];
}

/** Occurrences of O in lines at or after `from`, at the first tier that has one. */
function findFrom(lines: string[], O: string[], strict: boolean, from: number): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!tierEq(lines[i + j]!, O[j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of a hunk or chunk body: context (in O and in N), old (O only) or new (N only). */
interface Entry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line followed this body line (unified diffs). */
  noEol?: boolean;
  /** This entry came from an empty patch line (unified diffs). */
  emptyOrigin?: boolean;
}

const oldTexts = (entries: Entry[]): string[] => entries.filter((e) => e.kind !== 'new').map((e) => e.text);
const newCount = (entries: Entry[]): number => entries.filter((e) => e.kind !== 'old').length;

/** Replace the matched lines at `pos` by the entries' new side, honouring section 5. */
function applyEntries(lines: string[], pos: number, entries: Entry[], tier: number): string[] {
  const O = oldTexts(entries);
  const out = lines.slice(0, pos);
  let oi = 0;
  const F = leadST(lines[pos] ?? '');
  const P = leadST(O[0] ?? '');
  for (const e of entries) {
    if (e.kind === 'ctx') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (e.kind === 'old') {
      oi += 1;
    } else {
      let s = e.text;
      if (tier === 2 && s !== '' && trimST(s) !== '' && s.startsWith(P)) s = F + s.slice(P.length);
      out.push(s);
    }
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

/** The last context or `+` entry of a body, for the unified final-break rule. */
function lastCtxOrNew(entries: Entry[]): Entry | null {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.kind !== 'old') return entries[i]!;
  return null;
}

/* ------------------------- */
/* Section 4: format detect  */
/* ------------------------- */

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

/* ---------------------- */
/* Section 6: unified     */
/* ---------------------- */

interface UHunk {
  a: number;
  entries: Entry[];
}

interface USection {
  diffOld?: string;
  diffNew?: string;
  headOld?: string | null;
  headNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function headPath(line: string): string | null {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  const p = raw.trim();
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Collect a hunk body starting at index j; returns the entries and the index just past the body. */
function hunkBody(lines: string[], j: number): { entries: Entry[]; next: number } {
  const entries: Entry[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      entries.push({ kind: 'ctx', text: '', emptyOrigin: true });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') entries.push({ kind: 'ctx', text: l.slice(1) });
    else if (c === '-') entries.push({ kind: 'old', text: l.slice(1) });
    else if (c === '+') entries.push({ kind: 'new', text: l.slice(1) });
    else if (c === '\\') {
      if (entries.length > 0) entries[entries.length - 1]!.noEol = true;
      j += 1;
      continue;
    } else break;
    j += 1;
  }
  while (entries.length > 0) {
    const last = entries[entries.length - 1]!;
    if (last.kind === 'ctx' && last.emptyOrigin === true && last.noEol !== true) entries.pop();
    else break;
  }
  return { entries, next: j };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let header = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1]!, diffNew: m[2]!, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      header = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && header && cur.headOld === undefined) {
        cur.headOld = headPath(l);
        cur.headNew = headPath(lines[i + 1]!);
      } else {
        cur = { newFile: false, delFile: false, hunks: [], headOld: headPath(l), headNew: headPath(lines[i + 1]!) };
        sections.push(cur);
        header = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && header && l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      header = false;
      const body = hunkBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), entries: body.entries });
      i = body.next;
      continue;
    }
    if (cur !== null && header) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldPath: string | null = s.headOld !== undefined ? s.headOld : s.renameFrom !== undefined ? s.renameFrom : s.diffOld!;
  const newPath: string | null = s.headNew !== undefined ? s.headNew : s.renameTo !== undefined ? s.renameTo : s.diffNew!;
  const creation = oldPath === null || s.newFile;
  const deletion = !creation && (newPath === null || s.delFile);
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (creation) {
      const target = newPath!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const outLines: string[] = [];
      let lastPlus: Entry | null = null;
      for (const h of s.hunks) {
        for (const e of h.entries) {
          if (e.kind === 'new') {
            outLines.push(e.text);
            lastPlus = e;
          }
        }
      }
      tree.now.set(target, serialize({ br: '\n', lines: outLines, final: !(lastPlus !== null && lastPlus.noEol === true) }));
      return;
    }
    if (deletion) {
      const target = oldPath!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const from = oldPath!;
    const to = newPath!;
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    const move = from !== to;
    if (move && tree.get(to) !== null) throw new Fail('exists', to);
    const model = parseFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const O = oldTexts(h.entries);
      if (O.length === 0) {
        const fresh = h.entries.filter((e) => e.kind === 'new').map((e) => e.text);
        const pos = Math.min(h.a + d, model.lines.length);
        const atEnd = pos === model.lines.length;
        model.lines.splice(pos, 0, ...fresh);
        if (atEnd) {
          const last = lastCtxOrNew(h.entries);
          model.final = !(last !== null && last.noEol === true);
        }
        d += fresh.length;
      } else {
        const f = findFrom(model.lines, O, strict, 0);
        if (f === null) throw new Fail('no-match', from);
        const target = h.a - 1 + d;
        let pos = f.positions[0]!;
        for (const p of f.positions) {
          if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
        }
        const runsToEnd = pos + O.length === model.lines.length;
        model.lines = applyEntries(model.lines, pos, h.entries, f.tier);
        if (runsToEnd) {
          const last = lastCtxOrNew(h.entries);
          model.final = !(last !== null && last.noEol === true);
        }
        d += newCount(h.entries) - O.length;
      }
    }
    tree.now.set(to, serialize(model));
    if (move) {
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    }
  };
}

/* --------------------------- */
/* Section 7: SEARCH/REPLACE   */
/* --------------------------- */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j--) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      const t = cand.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${i + 1}`);
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    searchFrom = end + 1;
    i = end + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, serialize({ br: '\n', lines: b.newLines, final: true }));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = parseFile(before);
    const f = findFrom(model.lines, b.oldLines, strict, 0);
    if (f === null) throw new Fail('no-match', b.path);
    if (f.positions.length > 1) throw new Fail('ambiguous', b.path);
    const entries: Entry[] = [
      ...b.oldLines.map((t): Entry => ({ kind: 'old', text: t })),
      ...b.newLines.map((t): Entry => ({ kind: 'new', text: t })),
    ];
    model.lines = applyEntries(model.lines, f.positions[0]!, entries, f.tier);
    tree.now.set(b.path, serialize(model));
  };
}

/* ------------------- */
/* Section 8: V4A      */
/* ------------------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: Entry[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headLine: number;
  addLines?: string[];
  moveTo?: string;
  chunks?: VChunk[];
}

const V_HEADERS: [string, VSection['kind']][] = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'delete'],
  ['*** Update File: ', 'update'],
];

function vHeader(line: string): { kind: VSection['kind']; path: string } | null {
  for (const [prefix, kind] of V_HEADERS) {
    if (line.startsWith(prefix)) return { kind, path: line.slice(prefix.length).trim() };
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const h = vHeader(l);
    if (h === null) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    // The section's raw content: lines up to the next section header or the End Patch line.
    const raw: { text: string; num: number; emptyLine: boolean }[] = [];
    let j = i + 1;
    while (j < last && vHeader(lines[j]!) === null) {
      raw.push({ text: lines[j]!, num: j + 1, emptyLine: lines[j]! === '' });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (h.kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.emptyLine) addLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      sections.push({ kind: 'add', path: h.path, headLine, addLines });
    } else if (h.kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
      }
      sections.push({ kind: 'delete', path: h.path, headLine });
    } else {
      sections.push(vUpdateSection(h.path, headLine, raw));
    }
    i = j;
  }
  return sections.map((s) => vEdit(s, strict));
}

function vUpdateSection(path: string, headLine: number, raw: { text: string; num: number; emptyLine: boolean }[]): VSection {
  let moveTo: string | undefined;
  let start = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    start = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let closed = false;
  for (let k = start; k < raw.length; k++) {
    const r = raw[k]!;
    const t = r.text;
    if (t.startsWith('@@')) {
      cur = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), eof: false, entries: [] };
      chunks.push(cur);
      closed = false;
      continue;
    }
    if (t.startsWith('*** End of File') && t.slice('*** End of File'.length).trim() === '') {
      if (cur === null) throw new Exit2(`error: parse ${r.num}`);
      cur.eof = true;
      cur = null;
      closed = true;
      continue;
    }
    const isBody = t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+';
    if (!isBody) throw new Exit2(`error: parse ${r.num}`);
    if (cur === null) {
      if (closed || chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
      cur = { anchor: null, eof: false, entries: [] };
      chunks.push(cur);
    }
    if (t === '') cur.entries.push({ kind: 'ctx', text: '' });
    else if (t[0] === ' ') cur.entries.push({ kind: 'ctx', text: t.slice(1) });
    else if (t[0] === '-') cur.entries.push({ kind: 'old', text: t.slice(1) });
    else cur.entries.push({ kind: 'new', text: t.slice(1) });
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${headLine}`);
  return { kind: 'update', path, headLine, moveTo, chunks };
}

function vEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, serialize({ br: '\n', lines: s.addLines!, final: true }));
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const chunk of s.chunks!) {
      if (chunk.anchor !== null) {
        const f = findFrom(model.lines, [chunk.anchor], strict, cursor);
        if (f === null) throw new Fail('no-match', s.path);
        cursor = f.positions[0]! + 1;
      }
      const O = oldTexts(chunk.entries);
      if (O.length === 0) {
        const fresh = chunk.entries.filter((e) => e.kind === 'new').map((e) => e.text);
        const pos = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(pos, 0, ...fresh);
        cursor = pos + fresh.length;
      } else if (chunk.eof) {
        const p0 = model.lines.length - O.length;
        let placed: { tier: number } | null = null;
        if (p0 >= cursor) {
          for (const t of strict ? [0] : [0, 1, 2]) {
            let ok = true;
            for (let j = 0; j < O.length; j++) {
              if (!tierEq(model.lines[p0 + j]!, O[j]!, t)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              placed = { tier: t };
              break;
            }
          }
        }
        if (placed === null) throw new Fail('no-match', s.path);
        model.lines = applyEntries(model.lines, p0, chunk.entries, placed.tier);
        cursor = p0 + newCount(chunk.entries);
      } else {
        const f = findFrom(model.lines, O, strict, cursor);
        if (f === null) throw new Fail('no-match', s.path);
        const pos = f.positions[0]!;
        model.lines = applyEntries(model.lines, pos, chunk.entries, f.tier);
        cursor = pos + newCount(chunk.entries);
      }
    }
    if (s.moveTo !== undefined) {
      tree.now.set(s.moveTo, serialize(model));
      tree.now.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, serialize(model));
    }
  };
}

/* ---------------------- */
/* Section 9: JSON edits  */
/* ---------------------- */

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

/* -------------------------------- */
/* Sections 1, 2 and 10: the driver */
/* -------------------------------- */

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
            ? srEdits(lines, strict)
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
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per changed path, in byte order; a successful move replaces its D and A lines
  // with one R line that sorts by the new path (section 2).
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const movedAway = new Set<string>();
  const movedInto = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && (tree.now.get(oldP) ?? null) === null && tree.original(newP) === null && (tree.now.get(newP) ?? null) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      movedAway.add(oldP);
      movedInto.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedAway.has(p) || movedInto.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
