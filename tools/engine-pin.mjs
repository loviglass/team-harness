// Pins versions.env to OpenCode's official stable channel: npm `opencode-ai@latest`
// (the same source opencode.ai/install uses), with SHA-256 digests from the GitHub release.
//   node tools/engine-pin.mjs [--version X.Y.Z] [--check]
// Exit code: 0 = updated or already current, 10 = --check found a newer version.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "versions.env");
const ASSETS = {
  linux_x64: "opencode-linux-x64-baseline.tar.gz",
  linux_arm64: "opencode-linux-arm64.tar.gz",
  darwin_x64: "opencode-darwin-x64-baseline.zip",
  darwin_arm64: "opencode-darwin-arm64.zip",
  windows_x64: "opencode-windows-x64-baseline.zip",
  windows_arm64: "opencode-windows-arm64.zip",
};

async function json(url) {
  const headers = { Accept: "application/json", "User-Agent": "team-harness" };
  if (process.env.GITHUB_TOKEN && url.includes("api.github.com")) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

export function render(version, digests) {
  return [
    "# Pinned OpenCode engine: npm opencode-ai@latest (official stable channel).",
    "# Updated automatically by .github/workflows/engine.yml after install checks pass on all OSes.",
    `OPENCODE_VERSION=${version}`,
    ...Object.keys(ASSETS).map((k) => `OPENCODE_SHA256_${k}=${digests[k]}`),
    "",
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const current = /OPENCODE_VERSION=(\S+)/.exec(readFileSync(FILE, "utf8"))?.[1];
  const i = args.indexOf("--version");
  const version = i >= 0 ? args[i + 1] : (await json("https://registry.npmjs.org/opencode-ai/latest")).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unexpected version ${version}`);
  if (version === current) return console.log(`OpenCode ${current} is current`);
  if (args.includes("--check")) {
    console.log(`OpenCode update available: ${current} -> ${version}`);
    process.exit(10);
  }
  const release = await json(`https://api.github.com/repos/anomalyco/opencode/releases/tags/v${version}`);
  const digests = {};
  for (const [key, name] of Object.entries(ASSETS)) {
    const asset = release.assets.find((a) => a.name === name);
    const sha = asset?.digest?.replace(/^sha256:/, "");
    if (!/^[0-9a-f]{64}$/.test(sha || "")) throw new Error(`no sha256 digest for ${name} in v${version} (assets still publishing?)`);
    digests[key] = sha;
  }
  writeFileSync(FILE, render(version, digests));
  console.log(`Pinned OpenCode ${current} -> ${version}`);
}

main().catch((e) => { console.error(`engine-pin: ${e.message}`); process.exit(1); });
