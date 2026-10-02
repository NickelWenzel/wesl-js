import { expect, type Page, test } from "@playwright/test";

/** Open the LSP test page and wait for wgsl-analyzer to come up. */
async function openLspPage(page: Page): Promise<void> {
  await page.goto("/lsp.html");
  await page.waitForFunction(
    () => !!(document.querySelector("#lsp-editor") as any)?._lsp,
    null,
    { timeout: 30_000 },
  );
}

/** Focus the editor and put the cursor inside the first `needle`. */
async function placeCursor(page: Page, needle: string, offset = 0) {
  await page.locator("#lsp-editor .cm-content").click();
  await page.evaluate(
    ([n, o]) => {
      const view = (document.querySelector("#lsp-editor") as any).editorView;
      const pos = view.state.doc.toString().indexOf(n) + Number(o);
      view.dispatch({ selection: { anchor: pos } });
    },
    [needle, offset] as const,
  );
}

/** Text of each lint range in the editor, waiting until `expected` shows up. */
async function waitForLintText(page: Page, expected: string) {
  await page.waitForFunction(
    text =>
      [
        ...document
          .querySelector("#lsp-editor")!
          .shadowRoot!.querySelectorAll(".cm-lintRange-error"),
      ].some(e => e.textContent === text),
    expected,
    { timeout: 10_000 },
  );
}

test("is cross-origin isolated", async ({ page }) => {
  await openLspPage(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test("shows wgsl-analyzer diagnostics", async ({ page }) => {
  await openLspPage(page);
  await placeCursor(page, "fn main");
  await page.keyboard.press("Control+End");
  // a type error the WESL linker accepts, so only wgsl-analyzer reports it
  await page.keyboard.type(
    "\nfn bad() -> f32 { let x: u32 = 1.5; return 1.0; }",
  );
  await waitForLintText(page, "1.5");
});

test("completes symbols imported from another tab", async ({ page }) => {
  await openLspPage(page);
  await placeCursor(page, "fn main");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nfn other() -> f32 { return sca");
  await page.keyboard.press("Control+Space");
  const options = page.locator("#lsp-editor .cm-completionLabel");
  await expect(options.filter({ hasText: /^scale$/ }).first()).toBeVisible();
});

test("go to definition switches to the defining tab", async ({ page }) => {
  await openLspPage(page);
  await placeCursor(page, "scale(2.0)", 2);
  await page.keyboard.press("F12");
  await page.waitForFunction(
    () =>
      (document.querySelector("#lsp-editor") as any).activeFile === "util.wesl",
    null,
    { timeout: 10_000 },
  );
});

test("removing a tab removes it from the server", async ({ page }) => {
  await openLspPage(page);
  await page.evaluate(() => {
    (document.querySelector("#lsp-editor") as any).removeFile("util.wesl");
  });
  await placeCursor(page, "fn main");
  await page.keyboard.type(" "); // trigger a sync and diagnostics pull
  const diagnostics = () =>
    page.evaluate(() =>
      (document.querySelector("#lsp-editor") as any)._lsp.diagnostics(
        "main.wesl",
      ),
    );
  await expect
    .poll(async () => (await diagnostics()).length)
    .toBeGreaterThan(0);
});

/** Replace main.wesl (and constants) and wait for wgsl-analyzer's verdict on main.wesl. */
async function analyzerMessages(
  page: Page,
  main: string,
  constants?: Record<string, number>,
): Promise<string[]> {
  await page.evaluate(
    ([src, consts]) => {
      const el = document.querySelector("#lsp-editor") as any;
      if (consts) el.project = { constants: consts };
      el.source = src;
    },
    [main, constants] as const,
  );
  const messages = () =>
    page.evaluate(() =>
      (document.querySelector("#lsp-editor") as any)._lsp
        .diagnostics("main.wesl")
        .map((d: { message: string }) => d.message),
    );
  // let the edit sync and the server answer a diagnostics pull
  await page.waitForTimeout(2000);
  return messages();
}

test("resolves wgsl-play's default env package", async ({ page }) => {
  await openLspPage(page);
  const src = `import env::u;
fn size() -> vec2f { return u.resolution; }
fn bad() -> f32 { return u.nope; }
`;
  const messages = await analyzerMessages(page, src);
  expect(messages).toEqual([expect.stringContaining("no field `nope`")]);
});

test("types env::u by the @uniforms struct", async ({ page }) => {
  await openLspPage(page);
  const src = `import env::u;
@uniforms struct Params { @range(0.0, 1.0) speed: f32 }
fn speed() -> f32 { return u.speed; }
fn bad() -> vec2f { return u.resolution; }
`;
  const messages = await analyzerMessages(page, src);
  expect(messages).toEqual([expect.stringContaining("no field `resolution`")]);
});

test("resolves host constants", async ({ page }) => {
  await openLspPage(page);
  const src = `import constants::LIGHTS;
fn lights() -> i32 { return LIGHTS; }
`;
  const messages = await analyzerMessages(page, src, { LIGHTS: 4 });
  expect(messages).toEqual([]);
});

test("serves extension-less tabs as WESL", async ({ page }) => {
  await openLspPage(page);
  // tab names from module paths, as when a project is restored from storage
  await page.evaluate(() => {
    const el = document.querySelector("#lsp-editor") as any;
    el.addFile("shade", "fn shade() -> f32 { return 1.0; }\n");
    el.addFile(
      "uses",
      "import package::shade::shade;\nfn f() -> f32 { return shade(); }\n",
    );
  });
  await placeCursor(page, "fn f");
  await page.keyboard.type(" ");
  await page.waitForTimeout(2000);
  const messages = await page.evaluate(() =>
    (document.querySelector("#lsp-editor") as any)._lsp.diagnostics("uses"),
  );
  expect(messages).toEqual([]);
});
