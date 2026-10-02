# wgsl-edit

Web component for editing WESL/WGSL with CodeMirror 6.

## Usage

```html
<script type="module">import "wgsl-edit";</script>

<wgsl-edit></wgsl-edit>
```

Features syntax highlighting, linting, multi-file tabs, and light/dark themes
out of the box.

### Inline source

Include shader code directly via `<script>` tags:

```html
<wgsl-edit>
  <script type="text/wesl" data-name="main.wesl">
    import package::utils;
    @fragment fn main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
      return vec4f(utils::gradient(pos.xy), 1.0);
    }
  </script>
  <script type="text/wesl" data-name="utils.wesl">
    fn gradient(uv: vec2f) -> vec3f { return vec3f(uv, 0.5); }
  </script>
</wgsl-edit>
```

Multiple `<script>` tags create a multi-file editor with tabs.

### With wgsl-play

```html
<wgsl-edit id="editor" theme="auto">
  <script type="text/wesl">/* shader code */</script>
</wgsl-edit>
<wgsl-play from="editor"></wgsl-play>
```

The play component reads sources from the editor and live-previews the shader.

### Programmatic control

```typescript
const editor = document.querySelector("wgsl-edit");

editor.source = shaderCode;           // set active file content
editor.addFile("helpers.wesl", code); // add a file
editor.activeFile = "helpers.wesl";   // switch tabs

editor.project = {                    // load a full project
  weslSrc: { "package::main": code },
  rootModuleName: "package::main",
  conditions: { RED: true },
  packageName: "myshader",
};
```

## API

### Attributes

| Attribute | Values | Default | Description |
|-----------|--------|---------|-------------|
| `src` | URL | - | Load source from URL |
| `theme` | `light` `dark` `auto` | `auto` | Color theme |
| `readonly` | boolean | `false` | Disable editing |
| `tabs` | boolean | `true` | Show tab bar |
| `lint` | `on` `off` | `on` | Real-time WESL validation |
| `line-numbers` | `true` `false` | `false` | Show line numbers |
| `fetch-libs` | `true` `false` | `true` | Auto-fetch missing libraries from npm |
| `shader-root` | string | - | Root path for shader imports |
| `autosave` | `true` `false` | `false` | Persist edits to disk via dev server (use `wgsl-edit/autosave` plugin) |
| `lsp` | URL | - | Run wgsl-analyzer from this URL (empty or `true`: `/wgsl-analyzer/`), see [Language server](#language-server) |

### Properties

- `source: string` - Get/set active file content
- `conditions: Record<string, boolean>` - Get/set conditions for conditional
  compilation (`@if`/`@elif`/`@else`)
- `project: WeslProject` - Get/set full project (weslSrc, conditions, constants,
  packageName, libs)
- `activeFile: string` - Get/set active file name
- `fileNames: string[]` - List all file names
- `theme`, `tabs`, `lint`, `lineNumbers`, `readonly`, `shaderRoot`, `fetchLibs`
  - Mirror attributes

### Methods

- `link(options?): Promise<string>` - Compile WESL sources into WGSL, returns
  the linked output
- `addFile(name, content?)` - Add a new file
- `removeFile(name)` - Remove a file
- `renameFile(oldName, newName)` - Rename a file

### Events

- `change` - `WeslProject` detail on edit or conditions change
- `file-change` - `{ action, file }` on add/remove/rename

## Using with wesl-plugin

For full project support (libraries, conditional compilation, constants), use
[wesl-plugin](https://github.com/webgpu-tools/wesl-js/tree/main/packages/wesl-plugin)
to assemble shaders at build time and pass them to the editor via `project`.

```typescript
// vite.config.ts
import { linkBuildExtension } from "wesl-plugin";
import viteWesl from "wesl-plugin/vite";

export default {
  plugins: [viteWesl({ extensions: [linkBuildExtension] })]
};

// app.ts
import shaderConfig from "./shader.wesl?link";

const editor = document.querySelector("wgsl-edit");
editor.project = {
  ...shaderConfig,
  conditions: { MOBILE: isMobileGPU },
  constants: { num_lights: 4 }
};
```

The `?link` import provides `weslSrc`, `libs`, `rootModuleName`, and
`packageName`. The editor's linter uses these to validate imports, conditions,
and constants as you type.

## Autosave (dev mode)

When using wesl-plugin, edits can be persisted back to the source file on disk
during Vite development. Add the `wgslEditAutosave()` plugin alongside
wesl-plugin and set `autosave` on the editor:

```typescript
// vite.config.ts
import wgslEditAutosave from "wgsl-edit/autosave";
import { linkBuildExtension } from "wesl-plugin";
import viteWesl from "wesl-plugin/vite";

export default {
  plugins: [
    viteWesl({ extensions: [linkBuildExtension] }),
    wgslEditAutosave(),
  ],
};
```

```typescript
// app.ts
import shaderConfig from "./shader.wesl?link";

const editor = document.querySelector("wgsl-edit");
editor.project = shaderConfig;
editor.autosave = true;
```

`shader-root` is picked up automatically from the `?link` import, so edits land
in the right file on disk. Production builds never include the middleware, so
the same code is safe to ship.

## Language server

With `lsp` set, the editor runs
[wgsl-analyzer](https://github.com/wgsl-analyzer/wgsl-analyzer) in a Web Worker
via [wgsl-analyzer-web](https://www.npmjs.com/package/wgsl-analyzer-web):

- completion, including symbols imported from other tabs (Ctrl+Space)
- go to definition across tabs (F12)
- format document (Shift+Alt+F)
- type checking diagnostics, alongside the built-in WESL linting

Hover, signature help, rename (F2) and find references (Shift+F12) are wired up
too; they show results where wgsl-analyzer provides them.

```html
<wgsl-edit lsp></wgsl-edit>
```

The server needs two things from the host:

- **Its assets**: `worker.js`, `wgsl_analyzer.js` and `wgsl_analyzer.wasm` from
  `wgsl-analyzer-web/assets/`, in one directory under those names. The `lsp`
  attribute gives its URL (default `/wgsl-analyzer/`).
- **Cross-origin isolation**: the server uses `SharedArrayBuffer`, so pages must
  be served with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. Without them the editor logs a
  warning and works without the language server.

With Vite, `wgslEditAnalyzer()` does both: it serves the assets in dev, emits
them into builds, and sets the headers on the dev and preview servers. Your
production host must send the headers itself.

```typescript
// vite.config.ts
import wgslEditAnalyzer from "wgsl-edit/analyzer";

export default {
  plugins: [wgslEditAnalyzer()], // options: { base: "/wgsl-analyzer/", isolate: true }
};
```

The server code (~5 MB, mostly wasm) loads only when `lsp` is set. Each
`<wgsl-edit lsp>` starts its own server. The server also sees the packages
linked in at runtime: `constants` (from `project.constants`) and wgsl-play's
`env`, with `u` typed by the root module's `@uniforms` struct. Libraries fetched
from npm are not visible to the server.

## Styling

```css
wgsl-edit {
  height: 400px;
  border: 1px solid #444;
  border-radius: 4px;
}
```

## Bundle Size

~136 KB brotli for the full bundle with all dependencies.

| Component | Brotli |
|-----------|--------|
| CodeMirror (view, state, language, autocomplete, search, commands) | ~104 KB |
| lezer-wesl (grammar + lezer runtime) | ~26 KB |
| wesl linker (powers live linting) | ~14 KB |
| wgsl-edit (web component, theme, CSS) | ~1 KB |
| future work (tbd) | ~5 KB |


## CLI

Edit a shader file in the browser with live reload:

```bash
wgsl-edit path/to/shader.wesl
wgsl-edit shader.wgsl --port 3000 --no-open
```

## Exports

```typescript
import "wgsl-edit";                              // auto-registers element
import { WgslEdit } from "wgsl-edit/element";    // class only
import { wesl, weslLanguage } from "wgsl-edit/language"; // CodeMirror language
import "wgsl-edit/bundle";                       // pre-bundled, all deps included
import wgslEditAnalyzer from "wgsl-edit/analyzer"; // Vite plugin for `lsp`
```
