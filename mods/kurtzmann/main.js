// Kurtzmann: follows the focused Claude Code session and lists the files it and
// its subagents wrote or edited, with a filter, an inline preview and diffs
// against the file as it was before the agent touched it. Read-only: it reads
// transcripts and backups and runs git queries; temp files go under $TMPDIR.
//
// Focused terminal -> `hc get` foreground pid -> ~/.claude/sessions/<pid>.json
// -> sessionId -> ~/.claude/projects/*/<sessionId>.jsonl (+ <sessionId>/subagents/).
// Diff base: the session's first backup in ~/.claude/file-history/<sessionId>/
// (none = new file), else the first edit result's originalFile, else nothing.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, InputState, Input, TextView, Editor, EditorState } from "gpui-base";
import { focused, panes, exec, hc, home, appHome, readTextFile, run, theme, settings, window, checking, nextCommand, props, closeOverlay, notify } from "herdr";

const POLL_MS = 5000, GIT_MS = 30000, PREVIEW_MAX = 400000, DIFF_LINES = 4000;

// Per transcript, from its last offset to the last complete line: the new
// offset, its AI title, each successful Write/Edit as [path, time, created],
// and each file-history backup as [path, backupFileName | null, version].
const PARSE = `
import sys, json, os
a = sys.argv[1:]
for i in range(0, len(a), 2):
    p, o = a[i], int(a[i + 1]); r = {"p": p, "o": o, "e": [], "h": []}
    try:
        with open(p, "rb") as f:
            f.seek(o); b = f.read(); n = b.rfind(b"\\n") + 1; r["o"] = o + n
            for l in b[:n].splitlines():
                try:
                    if b'"aiTitle"' in l:
                        d = json.loads(l)
                        if d.get("type") == "ai-title": r["t"] = d.get("aiTitle")
                    elif b'"trackedFileBackups"' in l or b'"file-history-delta"' in l:
                        d = json.loads(l); t = d.get("type")
                        recs = d["snapshot"]["trackedFileBackups"].items() if t == "file-history-snapshot" else [(d["trackingPath"], d["backup"])] if t == "file-history-delta" else []
                        for tp, bk in recs:
                            full = tp if os.path.isabs(tp) else os.path.join(bk["realParentDir"], os.path.basename(tp)) if bk.get("realParentDir") else None
                            if full: r["h"].append([full, bk.get("backupFileName"), bk.get("version", 0)])
                    elif b'"structuredPatch"' in l or b'"notebook_path"' in l:
                        d = json.loads(l); u = d.get("toolUseResult")
                        if d.get("type") != "user" or not isinstance(u, dict): continue
                        fp = u.get("filePath") or u.get("notebook_path")
                        if fp and ("structuredPatch" in u or "notebook_path" in u):
                            r["e"].append([fp, d.get("timestamp", ""), u.get("type") == "create"])
                except Exception: pass
    except Exception as e: r["err"] = str(e)
    print(json.dumps(r))
`;

// The first edit result for a file across the session's transcripts: prints
// "new", "file <path>" (its originalFile, written to a temp file), or "none".
const ORIGINAL = `
import sys, json, os, hashlib, tempfile
want, sid, paths = sys.argv[1], sys.argv[2], sys.argv[3:]
best = None
for p in paths:
    with open(p, "rb") as f:
        for l in f:
            if b'"structuredPatch"' not in l or want.encode() not in l: continue
            try:
                d = json.loads(l); u = d.get("toolUseResult")
                if isinstance(u, dict) and u.get("filePath") == want and (best is None or d.get("timestamp", "") < best[0]):
                    best = (d.get("timestamp", ""), u)
            except Exception: pass
if best is None: print("none")
elif best[1].get("type") == "create": print("new")
elif isinstance(best[1].get("originalFile"), str):
    d = os.path.join(tempfile.gettempdir(), "herdr-kurtzmann", sid); os.makedirs(d, exist_ok=True)
    out = os.path.join(d, hashlib.sha1(want.encode()).hexdigest()[:16] + "-" + os.path.basename(want))
    with open(out, "w") as f: f.write(best[1]["originalFile"])
    print("file " + out)
else: print("none")
`;

// The session's transcripts with their sizes: "<size> <path>" per line.
const LIST = 'for f in "$HOME"/.claude/projects/*/"$1".jsonl "$HOME"/.claude/projects/*/"$1"/subagents/*.jsonl; do [ -f "$f" ] && printf "%s %s\\n" "$(wc -c < "$f" | tr -d " ")" "$f"; done; true';
const EXISTING = 'for f; do [ -e "$f" ] && printf "%s\\n" "$f"; done; true';

// Tools, overridable in config.json beside this file (see config.example.json).
// Commands run with sh -c; {file}, {before}, {after} and {dir} become quoted arguments.
const DEFAULTS = {
  place: "right",
  viewers: {
    md: "glow -p {file}",
    json: "jq -C . {file} | less -R",
    "*": null, // bat --paging=always when bat is installed, else less -R
  },
  open_with_app: ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff", "ico", "svg", "pdf", "html", "htm", "docx", "xlsx", "pptx", "key", "pages", "numbers", "zip", "mp4", "mov", "mp3", "wav"],
  app: "open {file}",
  reveal: "open -R {file}",
  diff: "difft --color=always {before} {after} | less -R",
  head_diff: "cd {dir} && DFT_COLOR=always GIT_EXTERNAL_DIFF=difft git --no-pager diff HEAD -- {file} | less -R",
  editor: null, // $VISUAL, else $EDITOR
  editor_in_terminal: null, // null: GUI editors (code, cursor, zed, …) run outside a terminal
};

// Prints "bat" if bat is installed, then the editor. Mods don't inherit the
// shell profile, so when VISUAL/EDITOR are unset here, ask the login shell.
const EDITOR_LOOKUP = `command -v bat >/dev/null && echo bat; e=\${VISUAL:-$EDITOR}; [ -n "$e" ] || e=$("\${SHELL:-/bin/sh}" -ilc 'printf __ED__%s "\${VISUAL:-$EDITOR}"' 2>/dev/null </dev/null | sed -n 's/.*__ED__//p'); printf %s "$e"`;

// A command template as argv: sh -c with each {name} as a positional argument.
function shell(command, vars) {
  const names = [], args = [];
  const script = command.replace(/\{(file|before|after|dir)\}/g, (_m, n) => {
    if (!names.includes(n)) { names.push(n); args.push(vars[n] ?? ""); }
    return `"$${names.indexOf(n) + 1}"`;
  });
  return ["sh", "-c", script, "sh", ...args];
}
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", yml: "yaml", svelte: "html", vue: "html", markdown: "md" };
const GUI_EDITORS = /^(code|code-insiders|cursor|zed|subl|idea|webstorm|goland|pycharm|fleet|windsurf|open)$/;

const tilde = (p) => (p && p.startsWith(home()) ? "~" + p.slice(home().length) : p);
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
const extOf = (p) => (p.split("/").pop().includes(".") ? p.split(".").pop().toLowerCase() : "");
const isMarkdown = (p) => ["md", "markdown", "mdx"].includes(extOf(p));
const ago = (ms) => {
  const d = (Date.now() - ms) / 1000;
  return d < 60 ? "now" : d < 3600 ? `${Math.round(d / 60)}m` : d < 86400 ? `${Math.round(d / 3600)}h` : `${Math.round(d / 86400)}d`;
};
const stop = (_e, cx) => cx.stop_propagation();
const tint = (c, a = "26") => (/^#[0-9a-f]{6}$/i.test(c) ? c + a : c);

// Subsequence match: the matched positions and a score (higher is better),
// favouring consecutive letters and letters in the file name. null: no match.
function fuzzy(query, text) {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase(), s = text.toLowerCase(), nameAt = s.lastIndexOf("/") + 1;
  const hits = [];
  let score = 0, j = 0, last = -2;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] !== q[j]) continue;
    score += 1 + (i === last + 1 ? 3 : 0) + (i >= nameAt ? 2 : 0) + (i === nameAt || "/-_. ".includes(s[i - 1] ?? "/") ? 2 : 0);
    hits.push(i); last = i; j++;
  }
  return j === q.length ? { score, hits } : null;
}

export default class AgentWork extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.at = 0;
    this.sessions = new Map(); // sessionId -> session
    this.current = null; // sessionId shown; stays when focus leaves Claude
    this.detail = null; // { path, tab: "preview" | "diff" | "head" }
    this.filter = "";
    this.input = InputState.new({ placeholder: "Filter files…  ( / )" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; this.scroll.scroll_to_item(0); cx.notify(); });
    this.input.on("submit", (_e, cx) => { const f = this.selected(); if (f) this.open(f.path, "preview", cx); this.handle.focus(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.envEditor = null;
    this.config = { ...DEFAULTS, viewers: { ...DEFAULTS.viewers, "*": "less -R {file}" } };
    if (checking()) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") { this.handle.focus(); cx.notify(); }
        else if (["view", "diff", "open", "opendiff", "editor", "finder"].includes(c)) { this.act(c, this.detail?.path ?? this.selected()?.path, cx); cx.notify(); }
      }
    });
    cx.spawn(async (cx) => {
      // Mods don't inherit the shell profile, so ask the login shell for the editor.
      const r = await exec("sh", ["-c", EDITOR_LOOKUP], { timeout: 10000 }).catch(() => null);
      const lines = (r?.stdout ?? "").split("\n");
      const bat = lines[0] === "bat";
      this.envEditor = (bat ? lines.slice(1) : lines).join("\n").trim() || null;
      let own = {};
      const raw = await readTextFile(`${appHome()}/mods/kurtzmann/config.json`).catch(() => null);
      try { own = raw ? JSON.parse(raw) : {}; } catch (e) { this.configError = `config.json: ${e}`; }
      this.config = { ...DEFAULTS, ...own, viewers: { ...DEFAULTS.viewers, ...(own.viewers ?? {}) } };
      this.config.viewers["*"] ??= bat ? "bat --paging=always {file}" : "less -R {file}";
      cx.notify();
    });
    this.poll(cx);
    cx.timer.every(POLL_MS, (cx) => window()?.visible !== false && this.poll(cx));
  }

  // --- Session tracking ----------------------------------------------------

  async resolve(terminal) {
    if (!terminal || terminal.includes("/")) return null; // remote: transcripts are on that machine
    const r = await hc(["get", terminal, "--json"]).catch(() => null);
    if (r?.code !== 0) return null;
    const pid = JSON.parse(r.stdout)?.foreground?.pid;
    if (!pid) return null;
    const raw = await readTextFile(`${home()}/.claude/sessions/${pid}.json`).catch(() => null);
    if (!raw) return null;
    const j = JSON.parse(raw);
    return j?.sessionId ? { id: j.sessionId, cwd: j.cwd, name: j.name } : null;
  }

  poll(cx) {
    if (this.busy) return;
    this.busy = true;
    const terminal = focused()?.terminal ?? null;
    this.terminal = terminal;
    cx.spawn(async (cx) => {
      try {
        const found = await this.resolve(terminal).catch(() => null);
        if (found) {
          const s = this.session(found.id);
          s.cwd = found.cwd ?? s.cwd;
          s.name = found.name ?? s.name;
          if (this.current !== found.id) { this.current = found.id; this.at = 0; this.closeDetail(); }
        }
        const s = this.current && this.sessions.get(this.current);
        if (s) {
          const grew = await this.readTranscripts(s);
          if (grew || !s.gitAt || Date.now() - s.gitAt > GIT_MS) await this.readGit(s);
        }
        this.error = null;
      } catch (e) { this.error = String(e); }
      finally { this.busy = false; cx.notify(); }
    });
  }

  session(id) {
    let s = this.sessions.get(id);
    if (!s) this.sessions.set(id, (s = { id, title: null, cwd: null, name: null, transcripts: new Map(), agents: new Map(), base: new Map(), before: new Map(), exists: new Set(), git: null, gitAt: 0 }));
    return s;
  }

  async readTranscripts(s) {
    const listed = await exec("sh", ["-c", LIST, "sh", s.id]);
    const due = [];
    for (const line of listed.stdout.split("\n")) {
      const m = line.match(/^(\d+) (.+\.jsonl)$/);
      if (!m) continue;
      const [size, path] = [Number(m[1]), m[2]];
      let t = s.transcripts.get(path);
      if (t && size < t.offset) { s.agents.delete(t.key); t = null; }
      if (!t) {
        const sub = path.match(/\/subagents\/(agent-[^/]+)\.jsonl$/)?.[1] ?? null;
        t = { offset: 0, key: sub ?? "main", name: sub ? await this.agentName(path, sub) : "main" };
        s.transcripts.set(path, t);
      }
      if (size > t.offset) due.push(path, String(t.offset));
    }
    if (!due.length) return false;
    const r = await exec("python3", ["-I", "-c", PARSE, ...due], { timeout: 60000 });
    for (const line of r.stdout.split("\n")) {
      if (!line) continue;
      const o = JSON.parse(line), t = s.transcripts.get(o.p);
      if (!t || o.err) continue;
      t.offset = o.o;
      if (o.t && t.key === "main") s.title = o.t;
      for (const [path, name, version] of o.h) {
        const prev = s.base.get(path);
        if (!prev || version < prev.version) s.base.set(path, { name, version });
      }
      let agent = s.agents.get(t.key);
      if (!agent) s.agents.set(t.key, (agent = { name: t.name, files: new Map() }));
      for (const [path, ts, created] of o.e) {
        const prev = agent.files.get(path);
        agent.files.set(path, { path, ts: Date.parse(ts) || Date.now(), created: created || prev?.created || false });
        s.before.delete(path);
      }
    }
    return true;
  }

  async agentName(path, sub) {
    const meta = await readTextFile(path.replace(/\.jsonl$/, ".meta.json")).catch(() => null);
    try { const j = meta ? JSON.parse(meta) : null; if (j?.name || j?.agentType) return j.name || j.agentType; } catch {}
    return sub.replace(/^agent-a?/, "").replace(/-[0-9a-f]{16}$/, "");
  }

  async readGit(s) {
    s.gitAt = Date.now();
    const paths = [...new Set([...s.agents.values()].flatMap((a) => [...a.files.keys()]))];
    if (paths.length) {
      const ex = await exec("sh", ["-c", EXISTING, "sh", ...paths]).catch(() => null);
      if (ex) s.exists = new Set(ex.stdout.split("\n").filter(Boolean));
    }
    if (!s.cwd) return;
    const st = await exec("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], { cwd: s.cwd }).catch(() => null);
    if (st?.code !== 0) { s.git = null; return; }
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: s.cwd }).catch(() => null);
    const head = st.stdout.match(/^# branch\.head (.+)$/m)?.[1];
    const ab = st.stdout.match(/^# branch\.ab \+(\d+) -(\d+)$/m);
    s.git = {
      top: top?.code === 0 ? top.stdout.trim() : s.cwd,
      branch: head ?? "(detached)",
      ahead: ab ? Number(ab[1]) : 0, behind: ab ? Number(ab[2]) : 0,
      dirty: st.stdout.split("\n").filter((l) => l && !l.startsWith("#")).length,
    };
  }

  // The file as it was before this session touched it: a path, "/dev/null" for
  // a new file, or null when there's no record of it.
  async beforeOf(s, path) {
    if (s.before.has(path)) return s.before.get(path);
    let out = null;
    const b = s.base.get(path);
    if (b) out = b.name ? `${home()}/.claude/file-history/${s.id}/${b.name}` : "/dev/null";
    else {
      const r = await exec("python3", ["-I", "-c", ORIGINAL, path, s.id, ...s.transcripts.keys()], { timeout: 60000 }).catch(() => null);
      const said = r?.stdout.trim() ?? "none";
      out = said === "new" ? "/dev/null" : said.startsWith("file ") ? said.slice(5) : null;
    }
    s.before.set(path, out);
    return out;
  }

  // --- Actions -------------------------------------------------------------

  appFile(path) {
    return this.config.open_with_app.includes(extOf(path));
  }

  // The configured command for this file's type, or null for the system's app.
  viewer(path) {
    if (this.appFile(path)) return null;
    const v = this.config.viewers, ext = extOf(path);
    return v[ext] ?? (isMarkdown(path) ? v.md : null) ?? v["*"];
  }

  openTerminal(command, vars, name) {
    run("terminal.open", { argv: shell(command, vars), place: this.config.place, name });
  }

  // Runs a command outside any terminal (the system app, reveal, a GUI editor).
  detached(command, vars, fail) {
    const [cmd, ...args] = shell(command, vars);
    exec(cmd, args).then((r) => { if (r.code !== 0) fail(r.stderr.trim() || `exit ${r.code}`); }, fail);
  }

  openViewer(path, fail) {
    const command = this.viewer(path);
    if (command) this.openTerminal(command, { file: path }, path.split("/").pop());
    else this.detached(this.config.app, { file: path }, fail);
  }

  openEditor(path, fail) {
    const editor = this.config.editor ?? this.envEditor ?? "vi";
    const words = editor.split(/\s+/).filter(Boolean);
    const gui = this.config.editor_in_terminal === false || (this.config.editor_in_terminal == null && GUI_EDITORS.test(words[0].split("/").pop()));
    if (gui) this.detached(`${words.filter((w) => w !== "--wait" && w !== "-w").join(" ")} {file}`, { file: path }, fail);
    else this.openTerminal(`${editor} {file}`, { file: path }, path.split("/").pop());
  }

  async openDiff(path, head) {
    const s = this.sessions.get(this.current);
    const name = `diff ${path.split("/").pop()}`;
    if (head) {
      this.openTerminal(this.config.head_diff, { file: path, dir: path.slice(0, path.lastIndexOf("/")) || "/" }, name);
      return;
    }
    const before = s && (await this.beforeOf(s, path));
    if (!before) throw new Error("No record of this file before the session. Use the vs HEAD tab, then D.");
    this.openTerminal(this.config.diff, { before, after: s.exists.has(path) ? path : "/dev/null", file: path }, name);
  }

  open(path, tab, cx) {
    this.detail = { path, tab, preview: null, diff: {}, };
    this.loadTab(cx);
  }

  closeDetail() {
    this.detail?.code?.release();
    this.detail = null;
  }

  loadTab(cx) {
    const d = this.detail, s = this.sessions.get(this.current);
    if (!d || !s) return;
    const path = d.path, tab = d.tab;
    if (tab === "preview" && d.preview === null) {
      d.preview = { loading: true };
      cx.spawn(async (cx) => {
        let p;
        if (!s.exists.has(path)) p = { note: "This file no longer exists." };
        else if (this.appFile(path)) p = { note: "No inline preview for this type. Open it with o." };
        else {
          const text = await readTextFile(path).catch(() => null);
          if (text === null) p = { note: "Can't read this file." };
          else if (text.includes("\0")) p = { note: "Binary file. Open it with o." };
          else {
            const body = text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + "\n… (truncated)" : text;
            if (isMarkdown(path)) p = { markdown: body };
            else {
              const t = theme(), ext = extOf(path) || "txt";
              d.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value: body,
                syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
              d.code.set_soft_wrap(true);
              p = { code: true };
            }
          }
        }
        if (this.detail === d) d.preview = p;
        cx.notify();
      });
    }
    if ((tab === "diff" || tab === "head") && !d.diff[tab]) {
      d.diff[tab] = { loading: true };
      cx.spawn(async (cx) => {
        let out;
        if (tab === "head") {
          const dir = path.slice(0, path.lastIndexOf("/")) || "/";
          const r = await exec("git", ["--no-optional-locks", "diff", "--no-color", "HEAD", "--", path], { cwd: dir }).catch((e) => ({ code: 2, stderr: String(e) }));
          out = r.code === 0 ? (r.stdout ? { text: r.stdout } : { note: "No changes against HEAD." }) : { note: /not a git repository/i.test(r.stderr) ? "Not in a git repository." : (r.stderr || "git diff failed.").trim() };
        } else {
          const before = await this.beforeOf(s, path);
          if (!before) out = { note: "No record of this file before the session. Try the HEAD diff." };
          else {
            const after = s.exists.has(path) ? path : "/dev/null";
            const r = await exec("git", ["diff", "--no-index", "--no-color", "-U3", "--", before, after], { cwd: home() }).catch((e) => ({ code: 2, stderr: String(e) }));
            out = r.code === 0 ? { note: "Unchanged since before the session." } : r.code === 1 ? { text: r.stdout, created: before === "/dev/null" } : { note: (r.stderr || "diff failed.").trim() };
          }
        }
        if (this.detail === d) d.diff[tab] = out;
        cx.notify();
      });
    }
  }

  setTab(tab, cx) {
    if (!this.detail) return;
    this.detail.tab = tab;
    this.loadTab(cx);
  }

  act(key, path, cx) {
    if (!path) return false;
    const fail = (e) => notify({ title: `Kurtzmann: ${key} failed`, body: String(e?.message ?? e), level: "error" });
    try {
      if (key === "view") this.open(path, "preview", cx);
      else if (key === "diff") this.open(path, "diff", cx);
      else if (key === "open") this.openViewer(path, fail);
      else if (key === "opendiff") { const head = this.detail?.tab === "head"; cx.spawn(async () => { try { await this.openDiff(path, head); } catch (e) { fail(e); } }); }
      else if (key === "editor") this.openEditor(path, fail);
      else if (key === "finder") this.detached(this.config.reveal, { file: path }, fail);
      else return false;
    } catch (e) { fail(e); }
    return true;
  }

  // An overlay closes itself, a pane (opened from the palette) closes its pane,
  // the layout's side panel hides.
  close() {
    const id = props()?.overlay;
    if (id) return closeOverlay(id);
    if (props()?.standalone) {
      const tab = focused()?.tab;
      const own = panes().find((p) => p.mod === "kurtzmann" && p.tab === tab);
      if (own) run("pane.close", { pane: own.pane });
      return;
    }
    run("layout.hide", { id: "panel" });
  }

  // --- View ----------------------------------------------------------------

  rows(s) {
    const out = [];
    if (!s) return out;
    const base = s.git?.top ?? s.cwd;
    const agents = [...s.agents.entries()].filter(([, a]) => a.files.size);
    const latest = (a) => Math.max(...[...a.files.values()].map((f) => f.ts));
    agents.sort(([ka, a], [kb, b]) => (ka === "main" ? -1 : kb === "main" ? 1 : latest(b) - latest(a)));
    for (const [key, a] of agents) {
      const files = [];
      for (const f of a.files.values()) {
        const shown = base && inside(f.path, base) ? f.path.slice(base.length + 1) : tilde(f.path);
        const m = fuzzy(this.filter, shown);
        if (m) files.push({ kind: "file", file: f, shown, hits: m.hits, score: m.score, id: `f-${key}-${f.path}` });
      }
      if (!files.length) continue;
      files.sort((x, y) => (this.filter ? y.score - x.score : 0) || y.file.ts - x.file.ts);
      if (agents.length > 1 || key !== "main") out.push({ kind: "agent", label: a.name, count: files.length });
      out.push(...files);
    }
    return out;
  }

  selected() {
    const s = this.sessions.get(this.current);
    const r = this.rows(s)[this.at];
    return r?.kind === "file" ? r.file : null;
  }

  // Text with the filter's matched letters highlighted, wrapping at any width.
  marked(text, hits, from, t) {
    const own = hits.filter((h) => h >= from && h < from + text.length).map((h) => h - from);
    if (!own.length) return div().child(text);
    const parts = [];
    let i = 0;
    const set = new Set(own);
    while (i < text.length) {
      const on = set.has(i);
      let j = i;
      while (j < text.length && set.has(j) === on) j++;
      parts.push(div().when(on, (el) => el.text_color(t.accent).font_semibold()).child(text.slice(i, j)));
      i = j;
    }
    return h_flex().flex_wrap().children(parts);
  }

  button(id, label, key, enabled, onClick, t) {
    return h_flex().id(id).h(22).px(6).gap(4).flex_none().items_center().rounded(5).border_1().border_color(t.border)
      .text_size(11).text_color(enabled ? t.foreground : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => { onClick(cx); cx.notify(); }))
      .on_mouse_down("left", stop)
      .child(div().child(label))
      .child(div().text_color(t.dim).child(key));
  }

  actions(path, prefix, t, s) {
    const exists = s.exists.has(path);
    const a = (k, label, key, ok = true) => this.button(`${prefix}-${k}-${path}`, label, key, ok, (cx) => this.act(k, path, cx), t);
    return h_flex().flex_wrap().gap(4)
      .when(!this.detail, (el) => el.child(a("view", "View", "↵")).child(a("diff", "Diff", "d")))
      .child(a("open", this.appFile(path) ? "Open app" : "Pager", "o", exists))
      .child(a("opendiff", "difft", "D"))
      .child(a("editor", "Editor", "e", exists))
      .child(a("finder", "Finder", "f", exists));
  }

  row(item, i, selected, s, t) {
    if (item.kind === "agent")
      return h_flex().pt(i ? 10 : 2).pb(2).px(8).gap(6).text_size(11).text_color(t.accent)
        .child(div().child(item.label)).child(div().text_color(t.dim).child(String(item.count)));
    const f = item.file, missing = !s.exists.has(f.path);
    const cut = item.shown.lastIndexOf("/");
    const name = item.shown.slice(cut + 1), dir = cut > 0 ? item.shown.slice(0, cut) : null;
    return v_flex().id(item.id).flex_none().px(8).py(4).gap(4).rounded(6).cursor_pointer()
      .when(selected, (el) => el.bg(t.selected))
      .hover((st) => st.bg(selected ? t.selected : t.hover))
      .on_mouse_down("left", stop)
      .on_click((e, cx) => { this.at = i; this.handle.focus(); if (e.click_count >= 2) this.open(f.path, "preview", cx); cx.notify(); })
      .child(h_flex().gap(8).items_start()
        .child(div().flex_none().w(12).text_size(11).text_color(missing ? t.dim : f.created ? t.ansi2 : t.blocked).child(missing ? "D" : f.created ? "A" : "M"))
        .child(v_flex().flex_1().min_w(0)
          .child(this.marked(name, item.hits, cut + 1, t).when(missing, (el) => el.text_color(t.dim)))
          .when(Boolean(dir), (el) => el.child(this.marked(dir, item.hits, 0, t).text_size(11).text_color(t.dim))))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(f.ts))))
      .when(selected, (el) => el.child(div().pl(20).child(this.actions(f.path, "row", t, s))));
  }

  diffView(out, t, font) {
    if (!out || out.loading) return div().p(12).text_size(12).text_color(t.dim).child("Loading diff…");
    if (out.note) return div().p(12).text_size(12).text_color(t.dim).child(out.note);
    const lines = out.text.split("\n");
    const body = [];
    let started = false;
    for (const l of lines.slice(0, DIFF_LINES)) {
      if (!started && !l.startsWith("@@")) continue;
      started = true;
      const c = l[0];
      const color = c === "+" ? t.ansi2 : c === "-" ? t.ansi1 : c === "@" ? t.accent : t.foreground;
      body.push(div().px(8).text_color(color).when(c === "+" || c === "-", (el) => el.bg(tint(color))).when(c === "@", (el) => el.mt(6)).child(l || " "));
    }
    if (lines.length > DIFF_LINES) body.push(div().p(8).text_color(t.dim).child("… diff truncated. Open it with D."));
    return v_flex().id("aw-diff").flex_1().min_h(0).overflow_y_scrollbar().py(6).font_family(font.font_family).text_size(Math.max(11, font.font_size - 2))
      .when(out.created, (el) => el.child(div().px(8).pb(4).text_size(11).text_color(t.dim).child("New file in this session")))
      .children(body);
  }

  detailView(s, t) {
    const d = this.detail, path = d.path, font = settings();
    const tabs = [["preview", "Preview", "1"], ["diff", "Diff", "2"], ["head", "vs HEAD", "3"]];
    let body;
    if (d.tab === "preview") {
      const p = d.preview;
      body = !p || p.loading ? div().p(12).text_size(12).text_color(t.dim).child("Loading…")
        : p.note ? div().p(12).text_size(12).text_color(t.dim).child(p.note)
        : p.markdown !== undefined ? v_flex().flex_1().min_h(0).px(12).py(8).child(TextView.markdown(`aw-md-${path}`, p.markdown).selectable(true).scrollable(true).size_full())
        : Editor.new(d.code).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0);
    } else body = this.diffView(d.diff[d.tab], t, font);
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(10).py(6).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_start()
          .child(div().id("aw-back").flex_none().px(4).rounded(4).cursor_pointer().text_color(t.muted).hover((st) => st.bg(t.hover))
            .on_mouse_down("left", stop).on_click((_e, cx) => { this.closeDetail(); this.handle.focus(); cx.notify(); }).child("←"))
          .child(v_flex().flex_1().min_w(0)
            .child(div().font_semibold().child(path.split("/").pop()))
            .child(div().text_size(11).text_color(t.dim).child(tilde(path.slice(0, path.lastIndexOf("/")))))))
        .child(h_flex().gap(4).children(tabs.map(([id, label, key]) =>
          h_flex().id(`aw-tab-${id}`).h(22).px(8).gap(4).items_center().rounded(5).text_size(12).cursor_pointer()
            .bg(d.tab === id ? t.selected : t.background).text_color(d.tab === id ? t.foreground : t.muted)
            .hover((st) => st.bg(t.hover)).on_mouse_down("left", stop)
            .on_click((_e, cx) => { this.setTab(id, cx); this.handle.focus(); cx.notify(); })
            .child(div().child(label)).child(div().text_size(10).text_color(t.dim).child(key)))))
        .child(this.actions(path, "detail", t, s)))
      .child(body);
  }

  render(cx) {
    const t = theme();
    if (!checking() && focused()?.terminal !== this.terminal) this.poll(cx);
    const s = this.current ? this.sessions.get(this.current) : null;
    const rows = this.rows(s);
    const pick = rows.map((r, i) => (r.kind === "file" ? i : -1)).filter((i) => i >= 0);
    if (pick.length && !pick.includes(this.at)) this.at = pick[0];
    const move = (n) => {
      const k = pick.indexOf(this.at);
      this.at = pick[Math.max(0, Math.min(pick.length - 1, k + n))] ?? this.at;
      this.scroll.scroll_to_item(this.at);
    };
    const sel = rows[this.at]?.kind === "file" ? rows[this.at].file.path : null;
    const g = s?.git;
    const sync = g ? [g.ahead ? `↑${g.ahead}` : "", g.behind ? `↓${g.behind}` : ""].filter(Boolean).join(" ") : "";
    const framed = !props()?.overlay;

    return v_flex().id("kurtzmann").size_full().min_h(0).text_color(t.foreground).text_size(13)
      .when(framed, (el) => el.rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border))
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const k = e.key, m = e.modifiers;
        if (m.control || m.platform || m.alt) return;
        if (this.typing) {
          if (k === "down") move(1);
          else if (k === "up") move(-1);
          else if (k === "escape") { this.input.set_value(""); this.filter = ""; this.handle.focus(); }
          else return;
        } else if (this.detail) {
          const path = this.detail.path;
          if (k === "escape" || k === "backspace" || k === "left" || k === "h" || k === "q") { this.closeDetail(); this.handle.focus(); }
          else if (k === "1" || k === "2" || k === "3") this.setTab(["preview", "diff", "head"][Number(k) - 1], cx);
          else if (k === "tab") this.setTab({ preview: "diff", diff: "head", head: "preview" }[this.detail.tab], cx);
          else if (k === "o") this.act("open", path, cx);
          else if (k === "d" && m.shift) this.act("opendiff", path, cx);
          else if (k === "d") this.setTab("diff", cx);
          else if (k === "e") this.act("editor", path, cx);
          else if (k === "f") this.act("finder", path, cx);
          else return;
        } else {
          if (k === "down" || k === "j") move(1);
          else if (k === "up" || k === "k") move(-1);
          else if (k === "end" || (k === "g" && m.shift)) move(1e6);
          else if (k === "home" || k === "g") move(-1e6);
          else if (k === "/") this.input.focus();
          else if (k === "escape" && this.filter) { this.input.set_value(""); this.filter = ""; }
          else if (k === "enter" || k === "space" || k === "right" || k === "l") this.act("view", sel, cx);
          else if (k === "d" && m.shift) this.act("opendiff", sel, cx);
          else if (k === "d") this.act("diff", sel, cx);
          else if (k === "o") this.act("open", sel, cx);
          else if (k === "e") this.act("editor", sel, cx);
          else if (k === "f") this.act("finder", sel, cx);
          else if (k === "r" && s) { s.gitAt = 0; this.poll(cx); }
          else return;
        }
        cx.stop_propagation();
        cx.notify();
      })
      .child(v_flex().flex_none().px(12).pt(8).pb(8).gap(2).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).font_semibold().child(s ? s.title || s.name || s.id.slice(0, 8) : "Kurtzmann"))
          .when(Boolean(this.configError), (el) => el.child(div().flex_none().text_size(11).text_color(t.blocked).child("config error")))
          .child(div().id("aw-close").px(5).rounded(4).text_color(t.dim).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", stop).on_click(() => this.close()).child("×")))
        .child(h_flex().gap(8).items_start().text_size(11).text_color(t.dim)
          .when(Boolean(g), (el) => el.child(div().flex_none().text_color(t.muted).child(g.branch)))
          .child(div().flex_1().min_w(0).child(tilde(s?.cwd) ?? ""))
          .when(Boolean(sync), (el) => el.child(div().flex_none().text_color(t.muted).child(sync)))
          .when(g?.dirty > 0, (el) => el.child(div().flex_none().text_color(t.blocked).child(`● ${g.dirty}`)))))
      .when(Boolean(this.detail) && Boolean(s), (el) => el.child(this.detailView(s, t)))
      .when(!this.detail, (el) => el
        .child(h_flex().flex_none().mx(8).mt(8).h(30).px(8).gap(6).items_center().rounded(7).border_1()
          .border_color(this.typing ? t.accent : t.border).bg(t.background)
          .on_mouse_down("left", stop)
          .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
        .child(v_flex().id("aw-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).p(6)
          .on_mouse_down("left", (_e, cx) => { this.handle.focus(); cx.stop_propagation(); })
          .when(!rows.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(
            this.error ?? (!s ? "Focus a terminal running Claude Code" : this.filter ? "No files match" : "No files written or edited yet"))))
          .children(rows.map((r, i) => this.row(r, i, i === this.at, s, t)))))
      .child(div().flex_none().px(12).py(5).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(this.detail ? "esc back   1 2 3 / tab switch view   o open   D difft   e editor   f finder"
          : "/ filter   j k move   ↵ view   d diff   o open   D difft   e editor   f finder"));
  }
}
