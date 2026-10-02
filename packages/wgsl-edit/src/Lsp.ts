import type { Diagnostic } from "@codemirror/lint";
import {
  findReferencesKeymap,
  formatKeymap,
  hoverTooltips,
  jumpToDefinitionKeymap,
  LSPClient,
  type LSPClientExtension,
  LSPPlugin,
  renameKeymap,
  serverCompletion,
  signatureHelp,
  type Transport,
  Workspace,
  type WorkspaceFile,
} from "@codemirror/lsp-client";
import {
  ChangeSet,
  type Extension,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import { type EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { type Disposable, WgslAnalyzerServer } from "wgsl-analyzer-web";

/** The parts of `<wgsl-edit>` a language server session reads and drives. */
export interface LspHost {
  /** Current document of every tab, keyed by tab name. */
  docs(): Map<string, Text>;
  view(): EditorView | null;
  /** Bring a tab into the view, e.g. to jump to a definition in another file. */
  showFile(name: string): EditorView | null;
  /** Apply a server-initiated edit (e.g. a rename) to a tab, active or not. */
  updateFile(name: string, spec: TransactionSpec): void;
  /** The server published different diagnostics for a tab. */
  diagnosticsChanged(name: string): void;
  /** Root module source of each package linked in at runtime, by name. */
  virtualPackages(): Record<string, string>;
}

/** wgsl-analyzer finds the package through wesl.toml; tabs live under its `root`. */
const edition = 'edition = "2026_pre"\n';
const shaderDir = "shaders";

/** Subset of LSP's `PublishDiagnosticsParams` read here. */
interface PublishDiagnostics {
  uri: string;
  version?: number;
  diagnostics: {
    range: { start: LspPosition; end: LspPosition };
    severity?: number;
    message: string;
  }[];
}

interface LspPosition {
  line: number;
  character: number;
}

/** Subset of LSP's `DocumentDiagnosticReport`. */
type DiagnosticReport =
  | { kind: "full"; items: PublishDiagnostics["diagnostics"] }
  | { kind: "unchanged" };

/** `data` of LSP's ServerCancelled error. */
interface RetryData {
  retriggerRequest?: boolean;
}

/** Server diagnostics as offsets into the doc they were published for. */
interface PublishedDiagnostics {
  raw: string;
  items: Diagnostic[];
  /** Changes synced to the server since publication, to map `items` forward. */
  mapping: ChangeSet;
}

/** wgsl-analyzer running in a Web Worker, connected to one `<wgsl-edit>`. */
export class LspSession {
  private plugins = new Map<string, Extension>();
  private server: WgslAnalyzerServer;
  private client: LSPClient;
  private workspace: TabWorkspace;

  private constructor(
    server: WgslAnalyzerServer,
    client: LSPClient,
    workspace: TabWorkspace,
  ) {
    this.server = server;
    this.client = client;
    this.workspace = workspace;
  }

  /** Boot wgsl-analyzer with the host's tabs. Rejects unless the page is
   *  cross-origin isolated, which the server's shared memory requires. */
  static async start(host: LspHost, baseUrl?: string): Promise<LspSession> {
    if (!globalThis.crossOriginIsolated) {
      throw new Error(
        "page is not cross-origin isolated (needs COOP/COEP headers)",
      );
    }
    const virtual = host.virtualPackages();
    const files = virtualPackageFiles(virtual);
    for (const [name, doc] of host.docs()) {
      files[shaderPath(name)] = doc.toString();
    }
    const server = await WgslAnalyzerServer.start({
      baseUrl,
      files,
      onStderr: line => console.debug("[wgsl-analyzer]", line),
    });

    let workspace!: TabWorkspace;
    const client = new LSPClient({
      rootUri: server.rootUri,
      workspace: c => {
        workspace = new TabWorkspace(c, host, server, virtual);
        return workspace;
      },
      extensions: [
        serverCompletion(),
        hoverTooltips(),
        signatureHelp(),
        // array-wrapped: LSPClient only keeps arrays or values with an
        // `.extension` property, which @codemirror/state 6.5's facet providers lack
        [
          keymap.of([
            ...formatKeymap,
            ...renameKeymap,
            ...jumpToDefinitionKeymap,
            ...findReferencesKeymap,
          ]),
        ],
        mergedDiagnostics(host, () => workspace),
      ],
    });
    // the server asks for a re-pull once it has loaded the workspace;
    // diagnostics pulled before then may call every file detached
    const refreshDiagnostics = () => {
      const view = host.view();
      const plugin = view && LSPPlugin.get(view);
      if (!plugin) return;
      workspace.pullDiagnostics(plugin.uri).then(file => {
        if (file) host.diagnosticsChanged(file.name);
      });
    };
    client.connect(serverTransport(server, refreshDiagnostics));
    return new LspSession(server, client, workspace);
  }

  /** Editor extension attaching a tab's EditorState to the server. Cached so
   *  the same tab yields an identical extension (compartments compare by identity). */
  plugin(name: string): Extension {
    const uri = this.workspace.uriOf(name);
    let ext = this.plugins.get(uri);
    if (!ext) {
      ext = this.client.plugin(uri, languageId(name));
      this.plugins.set(uri, ext);
    }
    return ext;
  }

  /** Reconcile the server with the host's tabs: open added, close removed,
   *  and send pending content changes. */
  syncFiles(): void {
    for (const uri of this.workspace.syncFileSet()) this.plugins.delete(uri);
    this.client.sync();
  }

  /** Latest server diagnostics for a tab, mapped onto its current doc. */
  diagnostics(name: string): Diagnostic[] {
    return this.workspace.diagnostics(name);
  }

  dispose(): void {
    this.client.disconnect();
    this.server.dispose();
  }
}

/** A tab, open on the server for the whole session so imports between tabs resolve. */
class TabFile implements WorkspaceFile {
  readonly name: string;
  readonly uri: string;
  version = 0;
  doc: Text;
  published: PublishedDiagnostics | undefined;
  private host: LspHost;

  constructor(name: string, uri: string, doc: Text, host: LspHost) {
    this.name = name;
    this.uri = uri;
    this.doc = doc;
    this.host = host;
  }

  get languageId(): string {
    return languageId(this.name);
  }

  /** The editor view, while this tab is the one it shows. */
  getView(): EditorView | null {
    const view = this.host.view();
    const plugin = view && LSPPlugin.get(view);
    return plugin?.uri === this.uri ? view : null;
  }
}

/**
 * Maps `<wgsl-edit>` tabs onto LSP documents.
 *
 * The editor shows one tab at a time by swapping EditorStates in a single
 * view, so only the active tab has an LSPPlugin. Every tab stays open on the
 * server regardless; inactive tabs sync by diffing their stored doc.
 */
class TabWorkspace extends Workspace {
  files: TabFile[] = [];
  private host: LspHost;
  private server: WgslAnalyzerServer;
  /** Virtual package sources as last sent to the server. */
  private virtual: Record<string, string>;
  private virtualVersion = 0;

  constructor(
    client: LSPClient,
    host: LspHost,
    server: WgslAnalyzerServer,
    virtual: Record<string, string>,
  ) {
    super(client);
    this.host = host;
    this.server = server;
    this.virtual = virtual;
    for (const [name, doc] of host.docs()) {
      this.files.push(new TabFile(name, this.uriOf(name), doc, host));
    }
  }

  uriOf(name: string): string {
    return this.server.uriOf(shaderPath(name));
  }

  fileNamed(name: string): TabFile | undefined {
    return this.files.find(f => f.name === name);
  }

  syncFiles() {
    this.syncVirtualPackages();
    const docs = this.host.docs();
    const updates = [];
    for (const file of this.files) {
      const prevDoc = file.doc;
      const pending = this.pendingChanges(file, docs);
      if (!pending) continue;
      const { doc, changes } = pending;
      file.doc = doc;
      if (changes.empty) continue;
      file.version++;
      if (file.published) {
        file.published.mapping = file.published.mapping.compose(changes);
      }
      updates.push({ file, prevDoc, changes });
    }
    return updates;
  }

  /** The tab's current doc and its changes since the last sync. */
  private pendingChanges(
    file: TabFile,
    docs: Map<string, Text>,
  ): { doc: Text; changes: ChangeSet } | undefined {
    const view = file.getView();
    const plugin = view && LSPPlugin.get(view);
    if (view && plugin) {
      const doc = view.state.doc;
      // a plugin created on tab switch starts from the tab's doc, which may
      // be ahead of what the server has
      const changes =
        plugin.syncedDoc === file.doc
          ? plugin.unsyncedChanges
          : replaceAll(file.doc, doc);
      plugin.clear();
      return { doc, changes };
    }
    const doc = docs.get(file.name);
    if (!doc || doc === file.doc) return;
    const changes = doc.eq(file.doc)
      ? ChangeSet.empty(doc.length)
      : replaceAll(file.doc, doc);
    return { doc, changes };
  }

  /** Also open the virtual packages, so their edits reach the server in
   *  order with the tabs' (a file write is picked up asynchronously). */
  connected(): void {
    super.connected();
    for (const [name, text] of Object.entries(this.virtual)) {
      const uri = this.server.uriOf(virtualPackagePath(name));
      const textDocument = { uri, languageId: "wesl", version: 0, text };
      this.client.notification("textDocument/didOpen", { textDocument });
    }
  }

  /** Send virtual packages whose source changed (e.g. env follows the root's
   *  @uniforms struct). Packages are fixed at startup: the server loads its
   *  package graph once, so names added later are ignored. */
  private syncVirtualPackages(): void {
    for (const [name, text] of Object.entries(this.host.virtualPackages())) {
      if (!(name in this.virtual) || this.virtual[name] === text) continue;
      this.virtual[name] = text;
      const uri = this.server.uriOf(virtualPackagePath(name));
      const version = ++this.virtualVersion;
      this.client.notification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
  }

  /** Open tabs the server hasn't seen and close those the host dropped.
   *  @return URIs of closed files. */
  syncFileSet(): string[] {
    const docs = this.host.docs();
    const removed = this.files.filter(f => !docs.has(f.name));
    const watched: { uri: string; type: number }[] = [];
    for (const file of removed) {
      this.client.didClose(file.uri);
      this.server.deleteFile(shaderPath(file.name));
      watched.push({ uri: file.uri, type: 3 /* Deleted */ });
    }
    this.files = this.files.filter(f => docs.has(f.name));
    for (const [name, doc] of docs) {
      if (this.fileNamed(name)) continue;
      const file = new TabFile(name, this.uriOf(name), doc, this.host);
      this.files.push(file);
      this.server.writeFile(shaderPath(name), doc.toString());
      this.client.didOpen(file);
      watched.push({ uri: file.uri, type: 1 /* Created */ });
    }
    if (watched.length) {
      const params = { changes: watched };
      this.client.notification("workspace/didChangeWatchedFiles", params);
    }
    return removed.map(f => f.uri);
  }

  /** Files are opened and closed per tab by syncFileSet, not per editor. */
  openFile(): void {}

  closeFile(): void {}

  updateFile(uri: string, update: TransactionSpec): void {
    const file = this.getFile(uri) as TabFile | null;
    if (file) this.host.updateFile(file.name, update);
  }

  displayFile(uri: string): Promise<EditorView | null> {
    const file = this.getFile(uri) as TabFile | null;
    return Promise.resolve(file && this.host.showFile(file.name));
  }

  /** Request diagnostics for a file; wgsl-analyzer only answers pull requests.
   *  @return the tab whose diagnostics changed, if any. */
  async pullDiagnostics(uri: string): Promise<TabFile | undefined> {
    await this.client.initializing;
    const file = this.getFile(uri) as TabFile | null;
    const capabilities = this.client.serverCapabilities;
    if (!file || !capabilities?.diagnosticProvider) return;
    const { version } = file;
    const params = { textDocument: { uri } };
    const method = "textDocument/diagnostic";
    let report: DiagnosticReport | undefined;
    for (let attempt = 0; attempt < 5 && !report; attempt++) {
      try {
        report = await this.client.request(method, params);
      } catch (e) {
        // the server cancels while still loading the workspace, asking to retry
        if (!(e as { data?: RetryData }).data?.retriggerRequest) return;
        if (file.version !== version) return; // a newer pull will follow
        await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
    if (report?.kind !== "full") return;
    return this.publish({ uri, version, diagnostics: report.items });
  }

  /** Store a publish, converting LSP positions against the doc it refers to.
   *  @return the tab whose diagnostics changed, if any. */
  publish(params: PublishDiagnostics): TabFile | undefined {
    const file = this.getFile(params.uri) as TabFile | null;
    if (!file) return;
    if (params.version != null && params.version !== file.version) return;
    const raw = JSON.stringify(params.diagnostics);
    if (file.published?.raw === raw) return;

    const { doc } = file;
    const items = params.diagnostics.map(d => {
      const severity = toSeverity(d.severity ?? 1);
      const from = fromPosition(doc, d.range.start);
      const to = fromPosition(doc, d.range.end);
      const { message } = d;
      return { from, to, severity, message, source: "wgsl-analyzer" };
    });
    const mapping = ChangeSet.empty(doc.length);
    file.published = { raw, items, mapping };
    return file;
  }

  diagnostics(name: string): Diagnostic[] {
    const file = this.fileNamed(name);
    if (!file?.published) return [];
    const { items, mapping } = file.published;
    const view = file.getView();
    const unsynced = view && LSPPlugin.get(view)?.unsyncedChanges;
    const map = (pos: number, assoc: number) => {
      const synced = mapping.mapPos(pos, assoc);
      return unsynced ? unsynced.mapPos(synced, assoc) : synced;
    };
    return items.map(d => {
      const from = map(d.from, 1);
      return { ...d, from, to: Math.max(from, map(d.to, -1)) };
    });
  }
}

/** Route server diagnostics into wgsl-edit's own linter instead of
 *  `serverDiagnostics()`, whose setDiagnostics would overwrite WESL lint
 *  results (and vice versa). Also keeps the server in sync while typing. */
function mergedDiagnostics(
  host: LspHost,
  workspace: () => TabWorkspace,
): LSPClientExtension {
  const changed = (file: TabFile | undefined) => {
    if (file) host.diagnosticsChanged(file.name);
  };

  /** Sync edits after a pause, then pull the active tab's diagnostics. */
  const autoSync = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout>;
      view: EditorView;
      constructor(view: EditorView) {
        this.view = view;
        // the tab was just attached: fetch its diagnostics once LSPPlugin exists
        this.timer = setTimeout(() => this.sync());
      }
      update(update: { docChanged: boolean }) {
        if (!update.docChanged) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.sync(), 500);
      }
      sync() {
        const plugin = LSPPlugin.get(this.view);
        if (!plugin) return;
        plugin.client.sync();
        workspace().pullDiagnostics(plugin.uri).then(changed);
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
  );

  return {
    clientCapabilities: {
      textDocument: { publishDiagnostics: { versionSupport: true } },
      workspace: { diagnostics: { refreshSupport: true } },
    },
    notificationHandlers: {
      "textDocument/publishDiagnostics": (_client, params) => {
        changed(workspace().publish(params));
        return true;
      },
    },
    editorExtension: autoSync,
  };
}

/** Adapt the server's parsed-object stream to lsp-client's string transport.
 *  Answers `workspace/diagnostic/refresh` here: LSPClient rejects every
 *  server-to-client request. */
function serverTransport(
  server: WgslAnalyzerServer,
  refreshDiagnostics: () => void,
): Transport {
  const subscriptions = new Map<(value: string) => void, Disposable>();
  const isRefresh = (m: unknown) =>
    (m as { method?: string }).method === "workspace/diagnostic/refresh";
  return {
    send: message => server.sendMessage(JSON.parse(message)),
    subscribe: handler => {
      const sub = server.onMessage(m => {
        if (!isRefresh(m)) return handler(JSON.stringify(m));
        const { id } = m as { id: number | string };
        server.sendMessage({ jsonrpc: "2.0", id, result: null });
        refreshDiagnostics();
      });
      subscriptions.set(handler, sub);
    },
    unsubscribe: handler => {
      subscriptions.get(handler)?.dispose();
      subscriptions.delete(handler);
    },
  };
}

/** wesl.toml declaring each virtual package as a path dependency, plus the
 *  packages themselves: `deps/<name>/` with its root module in package.wesl. */
function virtualPackageFiles(
  virtual: Record<string, string>,
): Record<string, string> {
  const names = Object.keys(virtual);
  const deps = names.map(n => `${n} = { path = "deps/${n}" }\n`).join("");
  const root = 'root = "./shaders"\n';
  const files: Record<string, string> = {
    "wesl.toml": `${edition}${root}[dependencies]\n${deps}`,
  };
  for (const name of names) {
    files[`deps/${name}/wesl.toml`] = `${edition}root = "."\n`;
    files[virtualPackagePath(name)] = virtual[name];
  }
  return files;
}

function virtualPackagePath(name: string): string {
  return `deps/${name}/package.wesl`;
}

/** A tab's file on the server. Tabs restored from module paths have no
 *  extension (`package::main` -> `main`); the server would read those as WGSL. */
function shaderPath(name: string): string {
  const hasExtension = /\.(wesl|wgsl)$/.test(name);
  return `${shaderDir}/${name}${hasExtension ? "" : ".wesl"}`;
}

function languageId(name: string): string {
  return name.endsWith(".wgsl") ? "wgsl" : "wesl";
}

function replaceAll(from: Text, to: Text): ChangeSet {
  return ChangeSet.of({ from: 0, to: from.length, insert: to }, from.length);
}

function toSeverity(severity: number): Diagnostic["severity"] {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  return severity === 3 ? "info" : "hint";
}

/** LSP line/character (UTF-16) to a doc offset, clamped to the doc. */
function fromPosition(doc: Text, pos: LspPosition): number {
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1);
  return Math.min(line.from + pos.character, line.to);
}
