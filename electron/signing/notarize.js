// electron/signing/notarize.js
// Hook: afterAllArtifactBuild (runs after DMG is created)
//
// Env vars:
//   SKIP_NOTARIZE=1        — skip entirely (local dev, no credentials)
//   NOTARIZE_MODE=async    — submit with --no-wait, write ID to release/notarization-id.txt (CI)
//   NOTARIZE_MODE=sync     — submit and wait inline (default, local with credentials)
/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("node:child_process");

function getEnv(name) {
  return process.env[name] || "";
}

function notarytool(args) {
  return execFileSync("xcrun", ["notarytool", ...args], { encoding: "utf-8" });
}

exports.default = async function notarizeHook(buildResult) {
  // afterAllArtifactBuild receives BuildResult:
  //   { outDir, artifactPaths, platformToTargets, configuration }
  if (process.platform !== "darwin") return;

  if (process.env.SKIP_NOTARIZE === "1") {
    console.log("SKIP_NOTARIZE=1 — skipping notarization.");
    return;
  }

  const appleId = getEnv("APPLE_ID");
  const appleIdPassword = getEnv("APPLE_APP_SPECIFIC_PASSWORD");
  const teamId = getEnv("APPLE_TEAM_ID");

  if (!appleId || !appleIdPassword || !teamId) {
    console.warn(
      "Skipping notarization: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, or APPLE_TEAM_ID not set.\n" +
      "To notarize locally: source .env.pack.apple && npm run pack:mac"
    );
    return;
  }

  // Find the DMG in the built artifacts
  const dmgPath = (buildResult.artifactPaths || []).find(
    (p) => p.toLowerCase().endsWith(".dmg")
  );
  if (!dmgPath) {
    console.warn("No DMG found in build artifacts. Skipping notarization.");
    return;
  }

  const creds = [
    "--apple-id", appleId,
    "--password", appleIdPassword,
    "--team-id", teamId
  ];
  const mode = (getEnv("NOTARIZE_MODE") || "sync").toLowerCase();

  if (mode === "async") {
    // -- async: submit without waiting (CI) --
    console.log(`Submitting DMG for async notarization: ${dmgPath}`);
    const output = notarytool([
      "submit", dmgPath,
      ...creds,
      "--no-wait",
      "--output-format", "json"
    ]);

    let id;
    try {
      id = JSON.parse(output).id;
    } catch {
      console.error("Failed to parse notarytool JSON output:", output);
      throw new Error("Could not parse notarization response");
    }

    if (!id) {
      throw new Error("notarytool returned no submission id");
    }

    // Write ID to file for CI finalize job
    const outDir = buildResult.outDir || path.dirname(dmgPath);
    const idFile = path.join(outDir, "notarization-id.txt");
    fs.writeFileSync(idFile, id, "utf-8");

    console.log(`NOTARIZATION_ID=${id}`);
    console.log(`Written to ${idFile}`);
    return;
  }

  // -- sync: submit and wait inline (local dev) --
  console.log(`Notarizing DMG (sync, may take several minutes): ${dmgPath}`);
  const output = notarytool([
    "submit", dmgPath,
    ...creds,
    "--wait",
    "--timeout", "1800",
    "--output-format", "json"
  ]);

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    console.log(output);
  }

  const status = parsed?.status;
  const uuid = parsed?.id;
  if (uuid) {
    console.log(`NOTARIZATION_ID=${uuid}`);
  }

  if (status !== "Accepted") {
    console.error("Notarization result:", output);
    throw new Error(`Notarization failed with status: ${status}`);
  }

  // Staple the ticket
  execFileSync("xcrun", ["stapler", "staple", dmgPath], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", dmgPath], { stdio: "inherit" });

  console.log("Notarization complete and stapled (DMG).");
};
