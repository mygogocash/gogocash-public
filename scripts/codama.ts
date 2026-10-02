/**
 * Generates the typed `gogocash_cashback` client from an Anchor IDL with
 * Codama, in a form Node's type stripping can load with no flags.
 *
 * Not run yet: the client needs the final R2 IDL, so src/generated/ is not
 * committed until R2 lands (docs/CONTRACT.md section 2.4 names the IDL files).
 *
 *   node scripts/codama.ts <anchor-idl.json> [output-folder]
 *
 * The default output folder is src/generated; any output folder must be named
 * `generated`, because the renderer deletes it before writing. Renderer options (verified
 * against the @codama/renderers-js 2.5.0 type definitions):
 * - `erasableSyntax: true` renders enums as a `const` object plus a type;
 * - `importExtension: "ts"` gives relative imports explicit `.ts` and
 *   `index.ts` specifiers;
 * - `kitImportStrategy: "rootOnly"` imports only from `@solana/kit` (a direct
 *   dependency), using its subpath exports where needed;
 * - `syncPackageJson: false` keeps the renderer away from package.json.
 *
 * The post-processing pass below is a second line of defense: it rewrites any
 * remaining numeric `enum` into the same `const` form, adds missing `.ts`
 * specifiers, then fails if non-erasable syntax or an extensionless relative
 * import is still present.
 *
 * Clients must never rely on the generated default program address: every
 * call passes `programAddress` from `release/manifest.json.programIds[cluster]`
 * (section 2.4).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rootNodeFromAnchor, type AnchorIdl } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const NUMERIC_ENUM = /export\s+enum\s+([A-Za-z_$][\w$]*)\s*\{([^}]*)\}/g;

/**
 * Rewrites `export enum Name { A, B }` (sequential, no initializers) into the
 * erasable form @codama/renderers-js 2.5.0 emits with `erasableSyntax`:
 * `export const Name = { 0: 'A', 1: 'B', A: 0, B: 1 } as const;` plus
 * `export type Name = (typeof Name)[Exclude<keyof typeof Name, number>];`.
 * Throws on an enum with initializers, which this pass does not understand.
 */
export function rewriteNumericEnums(source: string): string {
  return source.replace(NUMERIC_ENUM, (_match, name: string, body: string) => {
    const variants = body
      .split(",")
      .map((part) => part.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "").trim())
      .filter((part) => part.length > 0);
    for (const variant of variants) {
      if (!/^[A-Za-z_$][\w$]*$/.test(variant)) {
        throw new Error(`enum ${name}: unsupported variant "${variant}" (initializers are not rewritten).`);
      }
    }
    const reverse = variants.map((variant, index) => `${index}: '${variant}'`);
    const forward = variants.map((variant, index) => `${variant}: ${index}`);
    return (
      `export const ${name} = { ${[...reverse, ...forward].join(", ")} } as const;\n` +
      `export type ${name} = (typeof ${name})[Exclude<keyof typeof ${name}, number>];`
    );
  });
}

const RELATIVE_SPECIFIER = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*)\2/g;

/**
 * Gives every relative import or re-export specifier an explicit `.ts` file
 * or `/index.ts` directory target, resolved against `fileDir`.
 */
export function addTsSpecifiers(source: string, fileDir: string): string {
  return source.replace(RELATIVE_SPECIFIER, (match, prefix: string, quote: string, specifier: string) => {
    if (specifier.endsWith(".ts")) return match;
    const target = resolve(fileDir, specifier);
    if (existsSync(target) && statSync(target).isDirectory()) {
      return `${prefix}${quote}${specifier.replace(/\/$/, "")}/index.ts${quote}`;
    }
    const withoutJs = specifier.replace(/\.js$/, "");
    return `${prefix}${quote}${withoutJs}.ts${quote}`;
  });
}

/** Returns the problems that would stop Node's type stripping or break the import rule. */
export function findErasabilityProblems(source: string): string[] {
  const problems: string[] = [];
  if (/^\s*(export\s+)?(declare\s+)?(const\s+)?enum\s/m.test(source)) problems.push("enum declaration");
  if (/^\s*(export\s+)?(declare\s+)?(namespace|module)\s+[A-Za-z_$]/m.test(source)) problems.push("namespace or module declaration");
  if (/constructor\s*\([^)]*\b(public|private|protected|readonly)\s+[A-Za-z_$]/.test(source)) {
    problems.push("constructor parameter property");
  }
  for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
    const specifier = match[3] ?? "";
    if (!specifier.endsWith(".ts")) problems.push(`relative import without .ts: ${specifier}`);
  }
  return problems;
}

function listTsFiles(folder: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) files.push(...listTsFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

/** Applies the post-processing pass to every .ts file under `folder`; throws on leftovers. */
export function postProcessGeneratedClient(folder: string): void {
  const problems: string[] = [];
  for (const file of listTsFiles(folder)) {
    const before = readFileSync(file, "utf8");
    const after = addTsSpecifiers(rewriteNumericEnums(before), dirname(file));
    if (after !== before) writeFileSync(file, after);
    for (const problem of findErasabilityProblems(after)) problems.push(`${file}: ${problem}`);
  }
  if (problems.length > 0) {
    throw new Error(`Generated client is not loadable by Node type stripping:\n${problems.join("\n")}`);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const [idlPath, outputArg] = argv;
  if (idlPath === undefined) {
    throw new Error("usage: node scripts/codama.ts <anchor-idl.json> [output-folder]");
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outputFolder = resolve(outputArg ?? join(repoRoot, "src", "generated"));
  // The renderer deletes the output folder before writing. Only ever point it
  // at a folder named "generated", so a typo cannot wipe src/ or the repo.
  if (basename(outputFolder) !== "generated") {
    throw new Error(`Refusing to render into ${outputFolder}: the output folder must be named "generated".`);
  }
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as AnchorIdl;
  const root = rootNodeFromAnchor(idl);
  const visitor = renderVisitor(repoRoot, {
    // Resolved by the renderer relative to the package folder (repoRoot).
    generatedFolder: relative(repoRoot, outputFolder),
    deleteFolderBeforeRendering: true,
    erasableSyntax: true,
    importExtension: "ts",
    kitImportStrategy: "rootOnly",
    syncPackageJson: false,
    formatCode: true,
  });
  await visitor.visitRoot(root);
  postProcessGeneratedClient(outputFolder);
  process.stdout.write(`Generated ${outputFolder}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
