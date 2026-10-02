import { declsOfKind, parseSrcModule, type StructElem } from "wesl";

/** Default env:: module when no @uniforms struct is declared (as in wgsl-play). */
const defaultEnvSource = `struct Uniforms {
  resolution: vec2f,
  time: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
`;

/**
 * Sources for packages a host links in at runtime (wgsl-play's `env`, the
 * linker's `constants`), keyed by package name. The language server sees
 * only the editor's files, so without these their imports don't resolve.
 */
export function virtualPackages(
  names: string[],
  rootSource: string,
  constants: Record<string, string | number> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of names) {
    if (name === "env") result.env = envSource(rootSource);
    if (name === "constants") result.constants = constantsSource(constants);
  }
  return result;
}

/** wgsl-play's env module: `u` typed by the root's @uniforms struct, if any.
 *  wgsl-play imports that struct from the root module, but the language server
 *  rejects that dependency cycle, so the struct is copied here instead. */
function envSource(rootSource: string): string {
  const struct = uniformsStruct(rootSource);
  if (!struct) return defaultEnvSource;
  const name = struct.name.ident.originalName;
  const members = struct.members.map(m => {
    const type = rootSource.slice(m.typeRef.start, m.typeRef.end);
    return `  ${m.name.name}: ${type},\n`;
  });
  return `struct ${name} {\n${members.join("")}}
@group(0) @binding(0) var<uniform> u: ${name};
`;
}

function uniformsStruct(src: string): StructElem | undefined {
  try {
    const modulePath = "package::main";
    const ast = parseSrcModule({ modulePath, debugFilePath: "main", src });
    return declsOfKind(ast.moduleElem, "struct").find(isUniforms);
  } catch {
    return undefined;
  }
}

function isUniforms(struct: StructElem): boolean {
  return !!struct.attributes?.some(
    ({ attribute: a }) => a.kind === "@attribute" && a.name === "uniforms",
  );
}

/** Same declarations the linker's `constants` module provides. */
function constantsSource(constants: Record<string, string | number>): string {
  const decls = Object.entries(constants).map(
    ([name, value]) => `const ${name} = ${value};\n`,
  );
  return decls.join("");
}
