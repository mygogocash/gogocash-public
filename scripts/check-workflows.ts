/**
 * Lints every workflow in .github/workflows for this repository's hardening
 * rules (the header of ci.yml, plus the deploy rules of #2982):
 *
 *   pinned-uses              actions pinned by a 40-hex commit SHA (local ./ paths and
 *                            docker://...@sha256 digests allowed)
 *   no-expression-in-run     no `${{ }}` inside a `run:` script (GitHub expands it even in
 *                            a shell comment); values go through `env:`
 *   no-xtrace                no `set -x` / `set -o xtrace` / `bash -x`
 *   secrets-in-step-env      `secrets.*` (and `github.token`) only as `NAME: ${{ secrets.NAME }}`
 *                            in the `env:` of a single step, never in run, with, or job/workflow env
 *   umask-before-secret      a step that receives a secret runs `umask 077` before the first
 *                            line that uses it (key files are written mode 0600)
 *   secret-job-environment   a job that receives a secret declares an `environment:` (the
 *                            founder is its required reviewer)
 *   secret-cleanup           such a job writes its key files under ${RUNNER_TEMP}/keys/ and
 *                            deletes that directory (`rm -rf`) in an `if: always()` step that
 *                            comes after the steps that receive secrets and before any upload
 *   checkout-no-credentials  actions/checkout with `persist-credentials: false`
 *   read-only-token          a top-level `permissions:` and no `write` scope anywhere
 *   dispatch-no-inputs       `workflow_dispatch: {}`: no inputs to interpolate
 *   no-risky-triggers        no pull_request_target or workflow_run
 *   checksummed-downloads    a run that downloads with curl/wget also runs `sha256sum -c`
 *   no-pipe-to-shell         nothing piped from curl/wget into a shell
 *
 * The parser reads the YAML subset GitHub workflows use here (block maps and
 * sequences, block scalars, quoted and flow scalars kept raw).
 *
 *   node scripts/check-workflows.ts            # lint .github/workflows/*.yml
 *   node scripts/check-workflows.ts a.yml ...  # lint the given files
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A block scalar (`|` or `>`): its text and the 0-based line it starts on. */
export class Block {
  readonly block: string;
  readonly line: number;

  constructor(block: string, line: number) {
    this.block = block;
    this.line = line;
  }
}
export type YNode = string | null | Block | YNode[] | { [key: string]: YNode };
type YMap = { [key: string]: YNode };

export class WorkflowParseError extends Error {
  override name = "WorkflowParseError";
}

type Significant = { index: number; indent: number; text: string };

function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function significant(lines: string[], from: number): Significant | null {
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (line.startsWith("\t")) throw new WorkflowParseError(`line ${i + 1}: tabs are not valid YAML indentation.`);
    const indent = line.length - line.trimStart().length;
    return { index: i, indent, text: stripComment(line.slice(indent)) };
  }
  return null;
}

const isSeqItem = (text: string): boolean => text === "-" || text.startsWith("- ");

function scalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function blockScalar(lines: string[], from: number, parentIndent: number): [Block, number] {
  let i = from;
  const body: string[] = [];
  let blockIndent: number | null = null;
  for (; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) break;
    blockIndent ??= indent;
    body.push(line.slice(Math.min(indent, blockIndent)));
  }
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  return [new Block(body.join("\n"), from), i];
}

function parseNode(lines: string[], from: number): [YNode, number] {
  const s = significant(lines, from);
  if (s === null) return [null, lines.length];
  return isSeqItem(s.text) ? parseSeq(lines, s.index, s.indent) : parseMap(lines, s.index, s.indent);
}

const KEY = /^("[^"]*"|'[^']*'|[^\s"'][^:]*?):(?:\s+(.*))?$/;

function parseMap(lines: string[], from: number, indent: number): [YMap, number] {
  const map: YMap = {};
  let i = from;
  for (;;) {
    const s = significant(lines, i);
    if (s === null || s.indent < indent) return [map, s === null ? lines.length : s.index];
    if (s.indent > indent) throw new WorkflowParseError(`line ${s.index + 1}: unexpected indentation.`);
    if (isSeqItem(s.text)) return [map, s.index];
    const match = KEY.exec(s.text);
    if (match === null) throw new WorkflowParseError(`line ${s.index + 1}: expected "key: value".`);
    const key = scalar(match[1] as string);
    const rest = (match[2] ?? "").trim();
    if (Object.hasOwn(map, key)) throw new WorkflowParseError(`line ${s.index + 1}: duplicate key "${key}".`);
    i = s.index + 1;
    if (rest === "") {
      const next = significant(lines, i);
      if (next !== null && (next.indent > indent || (next.indent === indent && isSeqItem(next.text)))) {
        const [value, after] = parseNode(lines, i);
        map[key] = value;
        i = after;
      } else {
        map[key] = null;
      }
    } else if (/^[|>][-+]?$/.test(rest)) {
      const [value, after] = blockScalar(lines, i, indent);
      map[key] = value;
      i = after;
    } else {
      map[key] = scalar(rest);
    }
  }
}

function parseSeq(lines: string[], from: number, indent: number): [YNode[], number] {
  const items: YNode[] = [];
  let i = from;
  for (;;) {
    const s = significant(lines, i);
    if (s === null || s.indent < indent || (s.indent === indent && !isSeqItem(s.text))) {
      return [items, s === null ? lines.length : s.index];
    }
    if (s.indent > indent) throw new WorkflowParseError(`line ${s.index + 1}: unexpected indentation.`);
    const raw = lines[s.index] as string;
    const afterDash = raw.slice(s.indent + 1);
    const rest = afterDash.trimStart();
    if (stripComment(rest) === "") {
      const [value, after] = parseNode(lines, s.index + 1);
      items.push(value);
      i = after;
    } else if (KEY.test(stripComment(rest))) {
      // "- key: value" starts a mapping indented to the key's column.
      const column = s.indent + 1 + (afterDash.length - rest.length);
      lines[s.index] = " ".repeat(column) + rest;
      const [value, after] = parseMap(lines, s.index, column);
      items.push(value);
      i = after;
    } else {
      items.push(scalar(stripComment(rest)));
      i = s.index + 1;
    }
  }
}

/** Parses a workflow file into plain nodes (block scalars keep their text and line). */
export function parseWorkflowYaml(source: string): YNode {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const [root, end] = parseNode(lines, 0);
  const rest = significant(lines, end);
  if (rest !== null) throw new WorkflowParseError(`line ${rest.index + 1}: unexpected content.`);
  return root;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type Finding = { readonly file: string; readonly where: string; readonly rule: string; readonly message: string };

const isBlock = (node: YNode | undefined): node is Block => node instanceof Block;
const isMap = (node: YNode | undefined): node is YMap =>
  typeof node === "object" && node !== null && !Array.isArray(node) && !(node instanceof Block);
const text = (node: YNode | undefined): string | null => (typeof node === "string" ? node : isBlock(node) ? node.block : null);

const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40}$/;
const PINNED_DOCKER = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const SECRET_REF = /\$\{\{\s*(secrets\.[A-Za-z0-9_]+|github\.token)\s*\}\}/;
const SECRET_ENV_VALUE = /^\$\{\{\s*(secrets\.[A-Z][A-Z0-9_]*|github\.token)\s*\}\}$/;
const XTRACE = /(^|[\s;&|(])set\s+(-[A-Za-z]*x[A-Za-z]*|-o\s+xtrace)(\s|$)|(^|[\s;&|(])(ba|z|k)?sh\s+-[A-Za-z]*x/m;

function stepName(step: YMap, index: number): string {
  return text(step.name) ?? text(step.uses) ?? `step ${index + 1}`;
}

/** The one directory key files may be written to, and the cleanup that deletes it. */
const KEY_DIR = "${RUNNER_TEMP}/keys";
const KEY_DIR_CLEANUP = /(^|[\s;&|(])rm\s+-(rf|fr)\s+(--\s+)?"?\$\{RUNNER_TEMP\}\/keys\/?"?(\s|;|$)/m;
const ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))\s*$/;
// `>` or `>>` (not `2>`, `>&` or `<>`) and its target word.
const REDIRECT = /(?<![0-9&<>])>>?(?!&)\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g;

/**
 * The files a line that uses a secret redirects into, with `${name}` and
 * `$name` expanded from the plain assignments earlier in the same script.
 */
function redirectTargets(line: string, vars: ReadonlyMap<string, string>): string[] {
  const targets: string[] = [];
  for (const match of line.matchAll(REDIRECT)) {
    let target = (match[1] as string).replace(/^["']|["']$/g, "");
    for (let round = 0; round < 4; round += 1) {
      target = target.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced?: string, bare?: string) => {
        const name = (braced ?? bare) as string;
        if (name === "RUNNER_TEMP") return "${RUNNER_TEMP}";
        return vars.get(name) ?? whole;
      });
    }
    targets.push(target);
  }
  return targets;
}

/** Lints one workflow file's text. Returns every finding (empty when clean). */
export function lintWorkflow(source: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const add = (where: string, rule: string, message: string): void => {
    findings.push({ file, where, rule, message });
  };
  let root: YNode;
  try {
    root = parseWorkflowYaml(source);
  } catch (error) {
    add("file", "parse", (error as Error).message);
    return findings;
  }
  if (!isMap(root)) {
    add("file", "parse", "a workflow must be a mapping.");
    return findings;
  }

  // Triggers.
  const on = root.on;
  if (isMap(on)) {
    for (const trigger of ["pull_request_target", "workflow_run"]) {
      if (Object.hasOwn(on, trigger)) add("on", "no-risky-triggers", `${trigger} is not allowed.`);
    }
    if (Object.hasOwn(on, "workflow_dispatch")) {
      const dispatch = on.workflow_dispatch;
      if (!(dispatch === null || dispatch === "{}")) add("on.workflow_dispatch", "dispatch-no-inputs", "workflow_dispatch must be {} (no inputs).");
    }
  } else if (typeof on === "string" && /pull_request_target|workflow_run/.test(on)) {
    add("on", "no-risky-triggers", "pull_request_target and workflow_run are not allowed.");
  }

  // Token permissions.
  const checkPermissions = (node: YNode | undefined, where: string): void => {
    if (node === undefined) return;
    if (typeof node === "string") {
      if (/write/.test(node)) add(where, "read-only-token", `permissions "${node}" grants write access.`);
      return;
    }
    if (isMap(node)) {
      for (const [scope, value] of Object.entries(node)) {
        if (text(value) === "write") add(`${where}.${scope}`, "read-only-token", "write scopes are not allowed.");
      }
    }
  };
  if (!Object.hasOwn(root, "permissions")) add("permissions", "read-only-token", "a top-level permissions block is required.");
  checkPermissions(root.permissions, "permissions");

  // Workflow-level env must not carry secrets.
  const envSecrets = (env: YNode | undefined, where: string): void => {
    if (!isMap(env)) return;
    for (const [name, value] of Object.entries(env)) {
      if (SECRET_REF.test(text(value) ?? "")) add(`${where}.${name}`, "secrets-in-step-env", "secrets belong in the env of the single step that uses them.");
    }
  };
  envSecrets(root.env, "env");

  let allowedSecretRefs = 0;
  const jobs = isMap(root.jobs) ? root.jobs : {};
  for (const [jobId, jobNode] of Object.entries(jobs)) {
    if (!isMap(jobNode)) continue;
    const jobWhere = `jobs.${jobId}`;
    checkPermissions(jobNode.permissions, `${jobWhere}.permissions`);
    envSecrets(jobNode.env, `${jobWhere}.env`);
    const jobUses = text(jobNode.uses);
    if (jobUses !== null && !jobUses.startsWith("./") && !PINNED_ACTION.test(jobUses)) {
      add(`${jobWhere}.uses`, "pinned-uses", `"${jobUses}" is not pinned by a full commit SHA.`);
    }
    if (isMap(jobNode.secrets) || jobNode.secrets === "inherit") {
      add(`${jobWhere}.secrets`, "secrets-in-step-env", "secrets are never passed to a called workflow.");
    }
    const steps = Array.isArray(jobNode.steps) ? jobNode.steps : [];
    const secretSteps: number[] = [];
    const cleanupSteps: number[] = [];
    const uploadSteps: number[] = [];
    steps.forEach((stepNode, index) => {
      if (!isMap(stepNode)) return;
      const where = `${jobWhere} > ${stepName(stepNode, index)}`;
      const uses = text(stepNode.uses);
      if (uses !== null) {
        if (/^actions\/upload-artifact@/.test(uses)) uploadSteps.push(index);
        if (!uses.startsWith("./") && !PINNED_ACTION.test(uses) && !PINNED_DOCKER.test(uses)) {
          add(where, "pinned-uses", `"${uses}" is not pinned by a full commit SHA.`);
        }
        if (/^actions\/checkout@/.test(uses)) {
          const withNode = isMap(stepNode.with) ? stepNode.with : {};
          if (text(withNode["persist-credentials"]) !== "false") {
            add(where, "checkout-no-credentials", "actions/checkout needs persist-credentials: false.");
          }
        }
      }
      if (isMap(stepNode.with)) {
        for (const [name, value] of Object.entries(stepNode.with)) {
          if (SECRET_REF.test(text(value) ?? "")) add(`${where} with.${name}`, "secrets-in-step-env", "pass secrets through env, never with:.");
        }
      }
      const run = text(stepNode.run);
      const secretVars: string[] = [];
      if (isMap(stepNode.env)) {
        for (const [name, value] of Object.entries(stepNode.env)) {
          const valueText = text(value) ?? "";
          if (!SECRET_REF.test(valueText)) continue;
          if (!SECRET_ENV_VALUE.test(valueText) || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
            add(`${where} env.${name}`, "secrets-in-step-env", "a secret env entry must be exactly NAME: ${{ secrets.NAME }}.");
          }
          allowedSecretRefs += 1;
          secretVars.push(name);
        }
      }
      if (run !== null) {
        if (run.includes("${{")) add(where, "no-expression-in-run", "no ${{ }} inside run:; pass the value through env:.");
        if (XTRACE.test(run)) add(where, "no-xtrace", "shell tracing would print secrets; remove set -x.");
        if (/\b(curl|wget)\b/.test(run) && !/sha256sum\s+(-c|--check)\b/.test(run)) {
          add(where, "checksummed-downloads", "a download must be checked with sha256sum -c in the same step.");
        }
        if (/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/.test(run)) add(where, "no-pipe-to-shell", "never pipe a download into a shell.");
        const ifText = text(stepNode.if) ?? "";
        if (/\balways\(\)/.test(ifText) && KEY_DIR_CLEANUP.test(run)) cleanupSteps.push(index);
      }
      if (secretVars.length > 0) {
        secretSteps.push(index);
        if (run === null) {
          add(where, "umask-before-secret", "a step that receives a secret must be a run step that writes it under umask 077.");
          return;
        }
        const lines = run.split("\n");
        const umaskLine = lines.findIndex((line) => /^\s*umask\s+0?077\s*$/.test(line));
        const firstUse = lines.findIndex((line) =>
          secretVars.some((name) => new RegExp(`\\$\\{?${name}\\b`).test(line)),
        );
        if (umaskLine === -1 || (firstUse !== -1 && umaskLine > firstUse)) {
          add(where, "umask-before-secret", "run umask 077 before the first line that uses a secret.");
        }
        // A variable assigned from a secret counts as the secret.
        const vars = new Map<string, string>();
        const holders = new Set(secretVars);
        const usesSecret = (line: string): boolean => [...holders].some((name) => new RegExp(`\\$\\{?${name}\\b`).test(line));
        for (const line of lines) {
          const assignment = ASSIGNMENT.exec(line);
          if (assignment !== null) {
            const value = (assignment[2] ?? assignment[3] ?? assignment[4]) as string;
            if (usesSecret(value)) holders.add(assignment[1] as string);
            else vars.set(assignment[1] as string, value);
            continue;
          }
          if (!usesSecret(line)) continue;
          for (const target of redirectTargets(line, vars)) {
            if (!target.startsWith(`${KEY_DIR}/`)) {
              add(where, "secret-cleanup", `a secret is written to "${target}"; key files go under ${KEY_DIR}/ (the directory the cleanup deletes).`);
            }
          }
        }
      }
    });
    if (secretSteps.length > 0) {
      if (jobNode.environment === undefined || jobNode.environment === null) {
        add(jobWhere, "secret-job-environment", "a job that receives secrets must declare an environment with required reviewers.");
      }
      const lastSecretStep = secretSteps[secretSteps.length - 1] as number;
      const cleanup = cleanupSteps.find((index) => index > lastSecretStep);
      if (cleanup === undefined) {
        add(jobWhere, "secret-cleanup", `a job that receives secrets must run rm -rf -- "${KEY_DIR}" in an if: always() step after them.`);
      } else if (uploadSteps.some((index) => index > (secretSteps[0] as number) && index < cleanup)) {
        add(jobWhere, "secret-cleanup", "an upload-artifact step runs before the if: always() step that deletes the key files.");
      }
    }
  }

  // Every secret reference in the file must be one of the step env entries above.
  const totalSecretRefs = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .reduce((count, line) => count + (line.match(new RegExp(SECRET_REF.source, "g"))?.length ?? 0), 0);
  if (totalSecretRefs > allowedSecretRefs) {
    add("file", "secrets-in-step-env", `${totalSecretRefs - allowedSecretRefs} secret reference(s) outside a step env entry.`);
  }
  return findings;
}

function main(argv: readonly string[]): number {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files =
    argv.length > 0
      ? argv.map((file) => path.resolve(file))
      : fs
          .readdirSync(path.join(repoRoot, ".github", "workflows"))
          .filter((name) => /\.ya?ml$/.test(name))
          .sort()
          .map((name) => path.join(repoRoot, ".github", "workflows", name));
  let total = 0;
  for (const file of files) {
    const findings = lintWorkflow(fs.readFileSync(file, "utf8"), path.relative(repoRoot, file));
    for (const finding of findings) {
      process.stderr.write(`${finding.file}: ${finding.where}: [${finding.rule}] ${finding.message}\n`);
    }
    total += findings.length;
  }
  if (total === 0) process.stdout.write(`check-workflows: ${files.length} workflow(s), no findings.\n`);
  return total === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
