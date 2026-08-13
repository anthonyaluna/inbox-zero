import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const marketingDir = join("apps", "web", "app", "(marketing)");
const landingDir = join(marketingDir, "(landing)");
const token = process.env.GITHUB_MARKETING_TOKEN;

if (!token) {
  console.log("No GITHUB_MARKETING_TOKEN provided. Skipping private marketing clone.");
  process.exit(0);
}

if (existsSync(landingDir)) {
  console.log("Marketing directory already exists. Nothing to clone.");
  process.exit(0);
}

console.log("Cloning private marketing repository...");
const repository = `https://${token}@github.com/inbox-zero/marketing.git`;
execFileSync("git", ["clone", "--depth", "1", repository, marketingDir], {
  stdio: "inherit",
});
console.log("Private marketing repository cloned to the marketing route group.");
