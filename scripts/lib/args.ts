/**
 * A strict command-line parser for the operator scripts. Refusals never echo
 * a value that could be pasted key material: an unknown option is quoted
 * only when it has the shape of an option name, and an unexpected argument
 * is never quoted.
 */
import { isStrictBase58 } from "../../src/base58.ts";

/** A refusal whose message is safe to print: it never quotes key material. */
export class UsageError extends Error {
  override name = "UsageError";
}

export type ArgSpec = {
  /** Options that take one value, e.g. `--cluster`. */
  readonly values: readonly string[];
  /** Options that take a value and may repeat, e.g. `--vault`. */
  readonly repeatable?: readonly string[];
  /** Options without a value, e.g. `--export-squads`. */
  readonly flags: readonly string[];
};

export type ParsedArgs = {
  readonly values: ReadonlyMap<string, string>;
  readonly repeated: ReadonlyMap<string, readonly string[]>;
  readonly flags: ReadonlySet<string>;
};

const OPTION_NAME = /^--[a-z][a-z0-9-]*$/;

export function parseArgs(argv: readonly string[], spec: ArgSpec): ParsedArgs {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const flags = new Set<string>();
  const repeatable = spec.repeatable ?? [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (spec.flags.includes(arg)) {
      if (flags.has(arg)) throw new UsageError(`${arg} was given twice.`);
      flags.add(arg);
      continue;
    }
    const takesValue = spec.values.includes(arg);
    const repeats = repeatable.includes(arg);
    if (!takesValue && !repeats) {
      throw new UsageError(
        OPTION_NAME.test(arg)
          ? `unknown option ${arg}.`
          : "unexpected argument (not printed); these scripts never take key material on the command line.",
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value.`);
    index += 1;
    if (repeats) {
      const list = repeated.get(arg) ?? [];
      list.push(value);
      repeated.set(arg, list);
    } else {
      if (values.has(arg)) throw new UsageError(`${arg} was given twice.`);
      values.set(arg, value);
    }
  }
  return { values, repeated, flags };
}

// Option values that look like key text rather than a path: JSON array
// punctuation, or a path segment of 40+ base58/base64 characters in mixed
// case, or of 64+ hex digits (a 32-byte seed or more in any of them).
const JSON_PUNCTUATION = /[[\]{},]/;
const ENCODED_KEY = /^(?=[^a-z]*[a-z])(?=[^A-Z]*[A-Z])[A-Za-z0-9+=_-]{40,}$|^[0-9A-Fa-f]{64,}$/;

/** True when a value given as a file path has the shape of key text. */
export function looksLikeKeyText(value: string): boolean {
  return JSON_PUNCTUATION.test(value) || value.split(/[\\/]/).some((segment) => ENCODED_KEY.test(segment));
}

/** A path option, refused (without echo) when it has the shape of key text. */
export function pathOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.values.get(name);
  if (value === undefined) return undefined;
  if (looksLikeKeyText(value)) {
    throw new UsageError(
      `${name} does not look like a file path (it has the shape of key text); it was not printed. Pass the path of a file, never the key itself.`,
    );
  }
  return value;
}

/**
 * A public-key option: a strict base58 32-byte address. A 64-byte base58
 * value (the shape of a secret key) is refused without echo.
 */
export function addressValue(value: string, name: string): string {
  if (isStrictBase58(value, 32)) return value;
  if (isStrictBase58(value, 64)) {
    throw new UsageError(`${name} has the shape of a 64-byte secret key, not a public key; it was not printed.`);
  }
  throw new UsageError(`${name} must be a strict base58 public key.`);
}
