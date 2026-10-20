import os from "node:os";
import { vi } from "vitest";
import type { GatewayService } from "./service.js";

export function pathLikeToString(pathname: unknown): string {
  if (pathname instanceof URL) {
    return pathname.pathname;
  }
  return typeof pathname === "string"
    ? pathname
    : pathname instanceof Uint8Array
      ? Buffer.from(pathname).toString("utf8")
      : "";
}

// Keep OS-account fixtures out of the SDK-exposed spy barrel: node:os mock factories
// import that barrel, so importing node:os there would deadlock test collection.
export function mockSystemAccountHome(): void {
  const account = os.userInfo();
  // Native OS home APIs read the parent environment in Node worker threads.
  const homedir = () => process.env.HOME ?? account.homedir;
  vi.spyOn(os, "homedir").mockImplementation(homedir);
  vi.spyOn(os, "userInfo").mockImplementation(() => ({ ...account, homedir: homedir() }));
}

export type SystemdManagerSnapshotFixture = {
  programArguments: string[];
  workingDirectory?: string;
  environment?: string[];
  environmentFiles?: Array<[string, boolean]>;
  unsetEnvironment?: string[];
  fragmentPath?: string;
  dropInPaths?: string[];
  needDaemonReload?: boolean;
  loadState?: string;
};

const properties = (...entries: Array<[string, unknown]>) =>
  entries.map(([type, data]) => JSON.stringify({ type, data })).join("\n");

export function buildSystemdManagerPropertyOutput(snapshot: SystemdManagerSnapshotFixture): string {
  return properties(
    [
      "a(sasbttttuii)",
      [[snapshot.programArguments[0], snapshot.programArguments, false, 0, 0, 0, 0, 0, 0, 0]],
    ],
    ["s", snapshot.workingDirectory ?? ""],
    ["as", snapshot.environment ?? []],
    ["a(sb)", snapshot.environmentFiles ?? []],
    ["as", snapshot.unsetEnvironment ?? []],
  );
}

export function buildSystemdUnitPropertyOutput(
  params: Pick<SystemdManagerSnapshotFixture, "dropInPaths" | "needDaemonReload" | "loadState"> & {
    fragmentPath: string;
  },
): string {
  return properties(
    ["s", params.fragmentPath],
    ["as", params.dropInPaths ?? []],
    ["b", params.needDaemonReload ?? false],
    ["s", params.loadState ?? "loaded"],
    ["s", "enabled"],
    ["s", "active"],
    ["b", true],
    ["b", false],
  );
}

export function createMockGatewayService(overrides: Partial<GatewayService> = {}): GatewayService {
  return {
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => ({ outcome: "completed" as const })),
    isLoaded: vi.fn(async () => false),
    readCommand: vi.fn(async () => null),
    readRuntime: vi.fn(async () => ({ status: "stopped" as const })),
    ...overrides,
  };
}

export const managerlessPreflightCases = [
  ...(["git", "package"] as const).flatMap((updateInstallKind) =>
    ([false, true] as const).map((shouldRestart) => ({
      updateInstallKind,
      shouldRestart,
      condition: "absent",
      portUsage: "free" as const,
      portSource: "env" as const,
    })),
  ),
  ...(
    [
      { condition: "installed" },
      { condition: "node absent" },
      { condition: "node installed" },
      { condition: "global definition" },
      { condition: "unreadable" },
      { condition: "manager" },
      { condition: "busy port", portUsage: "busy", portSource: "env" },
      { condition: "configured busy port", portUsage: "busy", portSource: "config" },
      { condition: "unknown port", portUsage: "unknown", portSource: "env" },
    ] as const
  ).map((entry) =>
    Object.assign({ updateInstallKind: "package" as const, shouldRestart: true }, entry),
  ),
];
