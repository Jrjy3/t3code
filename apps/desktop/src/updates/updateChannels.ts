import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;
const HARNESS_SWITCHING_VERSION_PATTERN = /-harness-switching\.\d+$/;

export function isHarnessSwitchingDesktopVersion(version: string): boolean {
  return HARNESS_SWITCHING_VERSION_PATTERN.test(version);
}

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version) || isHarnessSwitchingDesktopVersion(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return isNightlyDesktopVersion(appVersion) ? "nightly" : "latest";
}
