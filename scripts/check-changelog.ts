import * as fs from "fs";
import * as path from "path";

function main() {
  const workspaceDir = path.resolve(__dirname, "..");
  const packageJsonPath = path.join(workspaceDir, "package.json");
  const changelogPath = path.join(workspaceDir, "CHANGELOG.md");

  if (!fs.existsSync(packageJsonPath)) {
    console.error(`Error: package.json not found at ${packageJsonPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(changelogPath)) {
    console.error(`Error: CHANGELOG.md not found at ${changelogPath}`);
    process.exit(1);
  }

  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch (err) {
    console.error(`Error parsing package.json: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const version = packageJson.version;
  if (!version) {
    console.error("Error: 'version' field not found in package.json");
    process.exit(1);
  }

  const changelog = fs.readFileSync(changelogPath, "utf8");

  // Escaping special characters in version for the regex matching ## [X.Y.Z]
  const escapedVersion = version.replace(/\./g, "\\.");
  const versionHeaderRegex = new RegExp(`^##\\s*\\[\\s*${escapedVersion}\\s*\\]`, "m");

  if (!versionHeaderRegex.test(changelog)) {
    console.error("================================================================================");
    console.error("❌ RELEASE CHECK FAILED: package.json version is ahead of CHANGELOG.md");
    console.error("================================================================================");
    console.error(`Current package.json version: ${version}`);
    console.error(`No entry found in CHANGELOG.md for version [${version}].`);
    console.error(`Please update CHANGELOG.md with release notes in the following format:`);
    console.error(`  ## [${version}] - YYYY-MM-DD`);
    console.error("================================================================================");
    process.exit(1);
  }

  console.log(`✅ Release check passed: CHANGELOG.md contains entry for version ${version}.`);
  process.exit(0);
}

main();
