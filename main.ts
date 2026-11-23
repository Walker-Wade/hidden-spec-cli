// mend: atomic text edits in unified diff, SEARCH/REPLACE, V4A, and JSON formats.
// Keep the trial runner hand-over at the end of this file unchanged.

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

type Body = { kind: string; text: string; noBreak?: boolean };
type Chunk = { body: Body[]; a?: number; anchor?: string; eof?: boolean };
function parseFault(n: number): never { throw new Exit2(`error: parse ${n}`); }
function fileLines(text: string) {
  const n = text.indexOf('\n');
  const br = n > 0 && text[n - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function render(f: ReturnType<typeof fileLines>): string {
  return f.lines.length ? f.lines.join(f.br) + (f.final ? f.br : '') : '';
}
function matches(lines: string[], old: string[], strict: boolean, min = 0, eof = false): { positions: number[]; tier: number } {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const norm = (s: string) => tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');
    const positions: number[] = [];
    for (let i = min; i + old.length <= lines.length; i++) {
      if (eof && i + old.length !== lines.length) continue;
      if (old.every((s, j) => norm(s) === norm(lines[i + j]))) positions.push(i);
    }
    if (positions.length) return { positions, tier };
  }
  return { positions: [], tier: 0 };
}
function replacement(lines: string[], at: number, body: Body[], tier: number): string[] {
  const old = body.filter(b => b.kind !== '+');
  const p = (old[0]?.text ?? '').match(/^[ \t]*/)![0];
  const f = (lines[at] ?? '').match(/^[ \t]*/)![0];
  let offset = 0;
  const result: string[] = [];
  for (const b of body) {
    if (b.kind === ' ') result.push(lines[at + offset]);
    else if (b.kind === '+') result.push(tier === 2 && !blank(b.text) && b.text.startsWith(p) ? f + b.text.slice(p.length) : b.text);
    if (b.kind !== '+') offset++;
  }
  return result;
}
function paths(tree: Tree, p: string, dest?: string, create = false): string {
  for (const x of dest === undefined ? [p] : [p, dest]) if (!safe(x)) throw new Fail('unsafe', x);
  const text = tree.get(p);
  if (create) { if (text !== null) throw new Fail('exists', p); return ''; }
  if (text === null) throw new Fail('missing', p);
  if (dest !== undefined && tree.get(dest) !== null) throw new Fail('exists', dest);
  return text;
}
function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previous = '', end = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') continue;
    let p = previous;
    for (let j = i - 1; j >= end; j--) if (!blank(lines[j]) && !lines[j].trim().startsWith('```')) { p = lines[j].trim(); break; }
    if (!p) parseFault(i + 1);
    const start = i;
    let mid = i + 1;
    while (mid < lines.length && lines[mid].trimEnd() !== '=======') mid++;
    let stop = mid + 1;
    while (stop < lines.length && lines[stop].trimEnd() !== '>>>>>>> REPLACE') stop++;
    if (stop >= lines.length) parseFault(start + 1);
    const old = lines.slice(i + 1, mid), add = lines.slice(mid + 1, stop);
    edits.push(tree => {
      const text = paths(tree, p, undefined, old.length === 0);
      if (!old.length) { tree.now.set(p, add.length ? add.join('\n') + '\n' : ''); return; }
      const f = fileLines(text), m = matches(f.lines, old, strict);
      if (!m.positions.length) throw new Fail('no-match', p);
      if (m.positions.length > 1) throw new Fail('ambiguous', p);
      const at = m.positions[0];
      const body = [...old.map(text => ({ kind: '-', text })), ...add.map(text => ({ kind: '+', text }))];
      f.lines.splice(at, old.length, ...replacement(f.lines, at, body, m.tier));
      tree.now.set(p, render(f));
    });
    previous = p; end = stop + 1; i = stop;
  }
  return edits;
}

function sectionEdit(p: string, dest: string | undefined, mode: string, chunks: Chunk[], strict: boolean, unified: boolean): Edit {
  return tree => {
    const text = paths(tree, p, dest, mode === 'add');
    if (mode === 'delete') { tree.now.set(p, null); return; }
    if (mode === 'add') {
      const plus = chunks.flatMap(c => c.body.filter(b => b.kind === '+'));
      tree.now.set(p, plus.length ? plus.map(b => b.text).join('\n') + (unified && plus.at(-1)?.noBreak ? '' : '\n') : '');
      return;
    }
    const f = fileLines(text);
    let cursor = 0, delta = 0;
    for (const c of chunks) {
      if (c.anchor) {
        const m = matches(f.lines, [c.anchor], strict, cursor);
        if (!m.positions.length) throw new Fail('no-match', p);
        cursor = m.positions[0] + 1;
      }
      const old = c.body.filter(b => b.kind !== '+').map(b => b.text);
      let at: number, tier = 0;
      if (!old.length) at = unified ? Math.max(0, Math.min(f.lines.length, c.a! + delta)) : c.eof ? f.lines.length : cursor;
      else {
        const m = matches(f.lines, old, strict, unified ? 0 : cursor, !!c.eof);
        if (!m.positions.length) throw new Fail('no-match', p);
        tier = m.tier;
        at = unified ? m.positions.reduce((best, x) => Math.abs(x - (c.a! - 1 + delta)) < Math.abs(best - (c.a! - 1 + delta)) ? x : best) : m.positions[0];
      }
      const add = replacement(f.lines, at, c.body, tier);
      if (unified && at + old.length === f.lines.length) f.final = !c.body.filter(b => b.kind !== '-').at(-1)?.noBreak;
      f.lines.splice(at, old.length, ...add);
      cursor = at + add.length; delta += add.length - old.length;
    }
    tree.now.set(dest ?? p, render(f));
    if (dest !== undefined) { tree.now.set(p, null); tree.moves.push([p, dest]); }
  };
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let sec: { old: string; next: string; mode: string; chunks: Chunk[]; paired: boolean } | undefined;
  const finish = () => {
    if (!sec) return;
    const { old, next, chunks } = sec;
    const mode = old === '/dev/null' ? 'add' : next === '/dev/null' ? 'delete' : sec.mode;
    const p = mode === 'add' ? next : old;
    const apply = sectionEdit(p, mode === 'change' && old !== next ? next : undefined, mode, chunks, strict, true);
    edits.push(tree => {
      // Both header paths belong to the edit, including mode-only additions/deletions.
      for (const name of [old, next]) {
        if (name !== '/dev/null' && !safe(name)) throw new Fail('unsafe', name);
      }
      apply(tree);
    });
  };
  const path = (s: string) => { const p = s.split('\t')[0].trim(); return p === '/dev/null' ? p : p.replace(/^[ab]\//, ''); };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) parseFault(i + 1);
      finish(); sec = { old: m[1], next: m[2], mode: 'change', chunks: [], paired: false };
    } else if (l.startsWith('--- ')) {
      if (!lines[i + 1]?.startsWith('+++ ')) { if (sec && !sec.chunks.length) parseFault(i + 2); continue; }
      if (!sec || sec.chunks.length || sec.paired) { finish(); sec = { old: '', next: '', mode: 'change', chunks: [], paired: false }; }
      sec.old = path(l.slice(4)); sec.next = path(lines[++i].slice(4)); sec.paired = true;
    } else if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/.exec(l);
      if (!m || !sec) parseFault(i + 1);
      const body: Body[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const b = lines[j];
        if (b.startsWith('--- ') && lines[j + 1]?.startsWith('+++ ')) break;
        if (b.startsWith('\\')) { if (body.length) body[body.length - 1].noBreak = true; }
        else if (b === '') body.push({kind: ' ', text: ''});
        else if (' +-'.includes(b[0])) body.push({kind: b[0], text: b.slice(1)});
        else break;
      }
      // Only literal empty patch lines at the end are excluded, not prefixed context lines.
      let trim = j - 1;
      while (trim > i && lines[trim] === '') { body.pop(); trim--; }
      sec.chunks.push({ body, a: Number(m[1]) }); i = j - 1;
    } else if (sec && !sec.chunks.length) {
      if (l.startsWith('new file mode')) sec.mode = 'add';
      else if (l.startsWith('deleted file mode')) sec.mode = 'delete';
      else if (!sec.paired && l.startsWith('rename from ')) sec.old = l.slice(12).trim();
      else if (!sec.paired && l.startsWith('rename to ')) sec.next = l.slice(10).trim();
    }
  }
  finish(); return edits;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex(l => !blank(l));
  if (first < 0 || lines[first].trim() !== '*** Begin Patch') parseFault(first < 0 ? 1 : first + 1);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last])) last--;
  if (lines[last].trim() !== '*** End Patch') parseFault(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i])) { i++; continue; }
    const header = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(lines[i]);
    if (!header) parseFault(i + 1);
    const start = i, p = header[2].trim(), mode = header[1];
    let end = i + 1;
    while (end < last && !/^\*\*\* (?:Add|Delete|Update) File: /.test(lines[end])) end++;
    let bodyEnd = end;
    while (bodyEnd > i + 1 && blank(lines[bodyEnd - 1])) bodyEnd--;
    i++;
    const chunks: Chunk[] = [];
    let dest: string | undefined;
    if (mode === 'Add') {
      const body: Body[] = [];
      for (; i < bodyEnd; i++) {
        if (lines[i] !== '' && !lines[i].startsWith('+')) parseFault(i + 1);
        body.push({ kind: '+', text: lines[i] === '' ? '' : lines[i].slice(1) });
      }
      chunks.push({body});
    } else if (mode === 'Delete') {
      if (i < bodyEnd) parseFault(i + 1);
    } else {
      if (i < bodyEnd && lines[i].startsWith('*** Move to: ')) dest = lines[i++].slice(13).trim();
      let current: Chunk | undefined;
      for (; i < bodyEnd; i++) {
        const l = lines[i];
        if (l.startsWith('@@')) {
          current = {body: [], anchor: l.slice(2).trim()}; chunks.push(current);
        } else if (l === '*** End of File') {
          if (!current) parseFault(i + 1);
          current.eof = true; current = undefined;
        } else if (l === '' || ' +-'.includes(l[0])) {
          if (!current) {
            if (chunks.length) parseFault(i + 1);
            current = {body: []}; chunks.push(current);
          }
          current.body.push({kind: l === '' ? ' ' : l[0], text: l === '' ? '' : l.slice(1)});
        } else parseFault(i + 1);
      }
      if (!chunks.length && dest === undefined) parseFault(start + 1);
    }
    edits.push(sectionEdit(p, dest, mode === 'Add' ? 'add' : mode === 'Delete' ? 'delete' : 'change', chunks, strict, false));
    i = end;
  }
  return edits;
}

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'search-replace' ? searchEdits(lines, strict) : kind === 'unified' ? unifiedEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.moves.length = moveCount;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const renamed = new Map<string, string>();
  const suppressed = new Set<string>();
  for (const [old, next] of tree.moves) {
    if (tree.original(old) !== null && tree.get(old) === null && tree.original(next) === null && tree.get(next) !== null && !suppressed.has(old) && !renamed.has(next)) {
      renamed.set(next, old); suppressed.add(old);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (renamed.has(p)) rows.push(`R ${renamed.get(p)} -> ${p}`);
    else if (!suppressed.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
