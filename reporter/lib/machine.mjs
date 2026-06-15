import os from "node:os";

// Stable, human-readable id for the machine this reporter runs on.
// Override with AI_USAGE_MACHINE (e.g. "desktop-4070s", "macbook", "vps") so
// renames of the OS hostname don't fork the history.
export function machineId() {
  const override = process.env.AI_USAGE_MACHINE?.trim();
  const raw = override || os.hostname() || "unknown";
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function machineMeta() {
  return {
    id: machineId(),
    hostname: os.hostname(),
    platform: process.platform, // win32 | darwin | linux
    arch: os.arch(),
  };
}
