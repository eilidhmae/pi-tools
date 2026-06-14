/**
 * checksum-cli — SHA-256 for bash runners, on the same pure-TS core the
 * `checksum` tool uses (no system hash binary; portable BSD↔GNU; works where a
 * jail forbids a shell).
 *
 * Usage:
 *   checksum-cli --file <path>                 print sha256 of a file
 *   checksum-cli --value <string>              print sha256 of a string
 *   checksum-cli --value-env <NAME>            print sha256 of $NAME (e.g. MYFILEDATA)
 *   checksum-cli --value-stdin                 print sha256 of stdin
 *   checksum-cli --file <path> --against-env  <NAME>   exit 0 iff file matches $NAME
 *   checksum-cli --file <path> --against-file <path2>   exit 0 iff the two files match
 *   checksum-cli --file <path> --expect <hexdigest>     exit 0 iff file matches the digest
 *
 * Prints the digest(s); in a comparison form it also prints `match=true|false`
 * and exits 0 on match, 1 on mismatch, 2 on a usage/IO error. Run with
 *   node --experimental-strip-types <...>/checksum-cli.ts <args>
 */
import { readFileSync } from "node:fs";
import { sha256Hex, digestsEqual } from "./sha256.ts";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}
function die(msg: string): never {
  process.stderr.write(`checksum-cli: ${msg}\n`);
  process.exit(2);
}

function fileDigest(path: string): string {
  try {
    return sha256Hex(new Uint8Array(readFileSync(path)));
  } catch (e) {
    die(`cannot read '${path}': ${(e as Error).message}`);
  }
}

// --- the subject digest (what we are measuring) ---
const file = arg("--file");
const value = arg("--value");
const valueEnv = arg("--value-env");
const valueStdin = has("--value-stdin");

let subject: string;
let subjectLabel: string;
if (file !== undefined) {
  subject = fileDigest(file);
  subjectLabel = "file";
} else if (value !== undefined) {
  subject = sha256Hex(value);
  subjectLabel = "value";
} else if (valueEnv !== undefined) {
  const v = process.env[valueEnv];
  if (v === undefined) die(`env var '${valueEnv}' is not set`);
  subject = sha256Hex(v);
  subjectLabel = `env:${valueEnv}`;
} else if (valueStdin) {
  subject = sha256Hex(new Uint8Array(readFileSync(0))); // fd 0 = stdin
  subjectLabel = "stdin";
} else {
  die("need one of --file / --value / --value-env / --value-stdin");
}

// --- optional comparison target ---
const expect = arg("--expect");
const againstEnv = arg("--against-env");
const againstFile = arg("--against-file");

let target: string | undefined;
if (expect !== undefined) target = expect;
else if (againstEnv !== undefined) {
  const v = process.env[againstEnv];
  if (v === undefined) die(`env var '${againstEnv}' is not set`);
  target = sha256Hex(v);
} else if (againstFile !== undefined) target = fileDigest(againstFile);

if (target === undefined) {
  // Plain digest mode.
  process.stdout.write(`${subject}\n`);
  process.exit(0);
}

const match = digestsEqual(subject, target);
process.stdout.write(`sha256(${subjectLabel})=${subject}\nexpect=${target.trim().toLowerCase()}\nmatch=${match}\n`);
process.exit(match ? 0 : 1);
