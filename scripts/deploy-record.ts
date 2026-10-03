/**
 * Writes the deployment evidence the deploy workflow uploads and the founder
 * commits (plan step R4, #2982):
 *
 *   <out-dir>/deployments/<cluster>.json   the full record (`npm run admin -- show` compares with it)
 *   <out-dir>/release/manifest.json        the manifest with deployments.<cluster> filled in
 *
 * Every input is public (addresses, hashes, slot, commit, tag). The vault
 * list is the `--record` file of `npm run admin -- initialize`. The deployed
 * program id must already be the manifest's `programIds.<cluster>`.
 *
 * `--previous` is the committed deployments/<cluster>.json. A vault that this
 * run only checked (`initialize --skip-existing` records no signature for
 * it) keeps the initialize signature that record holds, when the program,
 * name, mint and vault address are the same. A missing file (the first
 * deployment) carries nothing; a file that exists must parse.
 *
 *   node scripts/deploy-record.ts --cluster devnet --program-id <address> \
 *     --program-data <address> --upgrade-authority <address> --deploy-slot <slot> \
 *     --program-hash <hex> --so-sha256 <hex> --repository <owner/name> \
 *     --commit <sha> --tag <v*> --vaults <file> [--previous <file>] [--manifest <file>] \
 *     --out-dir <dir>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { address } from "@solana/kit";
import { isCluster } from "../src/clusters.ts";
import {
  AdminConfigError,
  buildDeploymentRecord,
  carryForwardInitializeSignatures,
  deploymentRecordToJson,
  manifestWithDeployment,
  parseDeploymentRecord,
  parseDeploymentVaults,
  parseReleaseManifest,
  releaseManifestToJson,
  toJsonText,
} from "../src/admin/config.ts";
import { addressValue, parseArgs, pathOption, UsageError } from "./lib/args.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const VALUES = [
  "--cluster",
  "--program-id",
  "--program-data",
  "--upgrade-authority",
  "--deploy-slot",
  "--program-hash",
  "--so-sha256",
  "--repository",
  "--commit",
  "--tag",
  "--vaults",
  "--previous",
  "--manifest",
  "--out-dir",
];

function readJson(filePath: string, label: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new AdminConfigError(`${label} cannot be read.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AdminConfigError(`${label} is not valid JSON.`);
  }
}

function main(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, { values: VALUES, flags: [] });
    const required = (name: string): string => {
      const value = args.values.get(name);
      if (value === undefined) throw new UsageError(`${name} is required.`);
      return value;
    };
    const cluster = required("--cluster");
    if (!isCluster(cluster)) throw new UsageError('--cluster must be "devnet" or "mainnet".');
    const slot = required("--deploy-slot");
    if (!/^(0|[1-9][0-9]{0,19})$/.test(slot)) throw new UsageError("--deploy-slot must be a decimal slot.");
    const vaultsPath = pathOption(args, "--vaults");
    const outDir = pathOption(args, "--out-dir");
    if (vaultsPath === undefined || outDir === undefined) throw new UsageError("--vaults and --out-dir are required.");
    const manifestPath = pathOption(args, "--manifest") ?? path.join(repoRoot, "release", "manifest.json");
    const previousPath = pathOption(args, "--previous");
    const previous =
      previousPath === undefined || !fs.existsSync(previousPath)
        ? null
        : parseDeploymentRecord(readJson(previousPath, "the --previous record"), cluster);
    const programId = address(addressValue(required("--program-id"), "--program-id"));

    const record = buildDeploymentRecord({
      cluster,
      programId,
      programDataAddress: address(addressValue(required("--program-data"), "--program-data")),
      upgradeAuthority: address(addressValue(required("--upgrade-authority"), "--upgrade-authority")),
      deploySlot: BigInt(slot),
      programHash: required("--program-hash"),
      soSha256: required("--so-sha256"),
      source: { repository: required("--repository"), commit: required("--commit"), tag: required("--tag") },
      vaults: carryForwardInitializeSignatures(
        parseDeploymentVaults(readJson(vaultsPath, "the --vaults file"), "the --vaults file"),
        programId,
        previous,
      ),
    });
    const manifest = manifestWithDeployment(parseReleaseManifest(readJson(manifestPath, "release/manifest.json")), record);

    const deploymentsOut = path.join(outDir, "deployments", `${cluster}.json`);
    const manifestOut = path.join(outDir, "release", "manifest.json");
    fs.mkdirSync(path.dirname(deploymentsOut), { recursive: true });
    fs.mkdirSync(path.dirname(manifestOut), { recursive: true });
    fs.writeFileSync(deploymentsOut, toJsonText(deploymentRecordToJson(record)));
    fs.writeFileSync(manifestOut, toJsonText(releaseManifestToJson(manifest)));
    process.stdout.write(`wrote deployments/${cluster}.json and release/manifest.json (${record.vaults.length} vault(s)).\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof AdminConfigError) {
      process.stderr.write(`deploy-record: ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`deploy-record: ${error instanceof Error ? error.message : "unexpected error"}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
