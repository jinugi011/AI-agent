/**
 * 원격 E2E 시험용 vscode API 대역 (Node 에서 실제 agent.ts / tools.ts 를 그대로 돌리기 위해).
 * 파일 시스템은 진짜 디스크를 쓰고, 설정은 SHIM.settings 로 주입한다.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const SHIM = { root: '', settings: {}, diagnostics: [] };

class Uri {
  constructor(fsPath) { this.fsPath = path.resolve(fsPath); this.path = this.fsPath; this.scheme = 'file'; }
  static file(p) { return new Uri(p); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  static parse(s) { return new Uri(s.replace(/^file:\/\//, '')); }
  toString() { return 'file://' + this.fsPath; }
  with() { return this; }
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
class FileSystemError extends Error {
  constructor(msg, code) { super(msg); this.code = code; this.name = 'FileSystemError'; }
}
const wrap = async (fn, uri) => {
  try { return await fn(); } catch (e) {
    if (e.code === 'ENOENT') throw new FileSystemError(`EntryNotFound (FileSystemError): ${uri.fsPath}`, 'FileNotFound');
    throw e;
  }
};

function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { const j = glob.indexOf('}', i); re += '(?:' + glob.slice(i + 1, j).split(',').map((x) => globToRe(x).slice(1, -1)).join('|') + ')'; i = j; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return '^' + re + '$';
}

function walk(dir, out, limit) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= limit) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '.git') walk(p, out, limit); } else out.push(p);
  }
}

class RelativePattern { constructor(base, pattern) { this.base = base.fsPath ?? base; this.pattern = pattern; } }

const workspace = {
  get workspaceFolders() { return SHIM.root ? [{ uri: Uri.file(SHIM.root), name: path.basename(SHIM.root), index: 0 }] : undefined; },
  textDocuments: [],
  getConfiguration(section) {
    return {
      get: (key, def) => (SHIM.settings[`${section}.${key}`] ?? def),
      update: async (key, value) => { SHIM.settings[`${section}.${key}`] = value; },
      has: (key) => `${section}.${key}` in SHIM.settings,
    };
  },
  asRelativePath(p, _inc) {
    const f = typeof p === 'string' ? p : p.fsPath;
    return path.relative(SHIM.root, f).split(path.sep).join('/');
  },
  async findFiles(include, exclude, max = 100000) {
    const base = include.base ?? SHIM.root;
    const pattern = include.pattern ?? include;
    const inc = new RegExp(globToRe(pattern));
    const exc = exclude ? new RegExp(globToRe(exclude)) : null;
    const all = [];
    walk(base, all, 200000);
    const out = [];
    for (const f of all) {
      const rel = path.relative(base, f).split(path.sep).join('/');
      if (!inc.test(rel)) continue;
      if (exc && exc.test(rel)) continue;
      out.push(Uri.file(f));
      if (out.length >= max) break;
    }
    return out;
  },
  fs: {
    stat: (uri) => wrap(async () => {
      const s = await fsp.stat(uri.fsPath);
      return { type: s.isDirectory() ? FileType.Directory : FileType.File, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
    }, uri),
    readFile: (uri) => wrap(async () => new Uint8Array(await fsp.readFile(uri.fsPath)), uri),
    writeFile: (uri, data) => wrap(async () => { await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fsp.writeFile(uri.fsPath, data); }, uri),
    createDirectory: (uri) => wrap(() => fsp.mkdir(uri.fsPath, { recursive: true }), uri),
    delete: (uri, opts = {}) => wrap(() => fsp.rm(uri.fsPath, { recursive: !!opts.recursive, force: false }), uri),
    rename: (a, b, opts = {}) => wrap(async () => {
      if (!opts.overwrite && fs.existsSync(b.fsPath)) throw new FileSystemError('FileExists', 'FileExists');
      await fsp.mkdir(path.dirname(b.fsPath), { recursive: true });
      await fsp.rename(a.fsPath, b.fsPath);
    }, a),
    readDirectory: (uri) => wrap(async () => (await fsp.readdir(uri.fsPath, { withFileTypes: true }))
      .map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]), uri),
  },
  async openTextDocument(uri) {
    const text = fs.readFileSync(uri.fsPath, 'utf8');
    return {
      uri, getText: () => text, positionAt: (o) => ({ offset: o }), save: async () => true,
      lineCount: text.split('\n').length,
    };
  },
  async applyEdit(edit) {
    for (const op of edit.ops) {
      fs.mkdirSync(path.dirname(op.uri.fsPath), { recursive: true });
      fs.writeFileSync(op.uri.fsPath, op.content);
    }
    return true;
  },
  onDidChangeConfiguration: () => ({ dispose() {} }),
};

class WorkspaceEdit {
  constructor() { this.ops = []; }
  createFile(uri, o = {}) { this.ops.push({ uri, content: Buffer.from(o.contents ?? []) }); }
  replace(uri, _range, content) { this.ops.push({ uri, content }); }
}
class Range { constructor(a, b) { this.start = a; this.end = b; } }
class Position { constructor(l, c) { this.line = l; this.character = c; } }
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

module.exports = {
  SHIM, Uri, FileType, FileSystemError, RelativePattern, workspace, WorkspaceEdit, Range, Position, DiagnosticSeverity,
  Diagnostic: class {},
  languages: { getDiagnostics: (uri) => (uri ? [] : SHIM.diagnostics) },
  window: { showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {}, createOutputChannel: () => ({ appendLine() {}, append() {}, show() {} }) },
  commands: { executeCommand: async () => undefined },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  env: { openExternal: async () => true },
  ConfigurationTarget: { Global: 1 },
};
