import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  mapCodexAppServerLocalWorkspacePath,
  mapCodexAppServerRemoteWorkspacePath,
} from "./remote-workspace-path.js";

const localWorkspaceRoot = path.resolve("gateway-workspace");
const remoteWorkspaceRoot = "/remote/codex-workspace";
const roots = { localWorkspaceRoot, remoteWorkspaceRoot };
const localPath = (value: string, overrides: Partial<typeof roots> = {}) =>
  mapCodexAppServerLocalWorkspacePath({ ...roots, ...overrides, value });
const remotePath = (value: string, overrides: Partial<typeof roots> = {}) =>
  mapCodexAppServerRemoteWorkspacePath({ ...roots, ...overrides, value });

describe("Codex remote workspace paths", () => {
  it("maps an artifact under a gateway root workspace into the remote workspace", () => {
    expect(remotePath("/reports/slack-upload.txt", { localWorkspaceRoot: "/" })).toBe(
      `${remoteWorkspaceRoot}/reports/slack-upload.txt`,
    );
  });

  it("preserves URL-backed and managed media sources", () => {
    for (const value of [
      "https://example.com/image.png",
      "mxc://example.org/image",
      "buffer://generated-image",
      "media://inbound/image.png",
      "data:image/png;base64,aGVsbG8=",
    ]) {
      expect(localPath(value)).toBe(value);
    }
  });

  it("normalizes harmless relative and nested dot segments", () => {
    for (const value of [
      "./reports/slack-upload.txt",
      "reports/./slack-upload.txt",
      `${remoteWorkspaceRoot}/reports/./slack-upload.txt`,
    ]) {
      expect(localPath(value)).toBe(path.join(localWorkspaceRoot, "reports", "slack-upload.txt"));
    }
  });

  it("preserves case-insensitive Windows drive-root workspace paths", () => {
    expect(localPath("c:\\Reports\\Upload.TXT", { remoteWorkspaceRoot: "C:\\" })).toBe(
      path.join(localWorkspaceRoot, "Reports", "Upload.TXT"),
    );
  });

  it("projects gateway artifacts into Windows drive roots without duplicate slashes", () => {
    expect(
      remotePath(path.join(localWorkspaceRoot, "reports", "upload.txt"), {
        remoteWorkspaceRoot: "C:\\",
      }),
    ).toBe("C:/reports/upload.txt");
  });

  it("continues rejecting case-insensitive Windows sibling paths", () => {
    expect(() =>
      localPath("c:\\work\\repo-other\\private.txt", { remoteWorkspaceRoot: "C:\\Work\\Repo" }),
    ).toThrow("outside");
  });

  it("rejects remote sibling and gateway-local filesystem paths", () => {
    for (const value of [
      `${remoteWorkspaceRoot}-other/report.txt`,
      "/etc/passwd",
      path.join(localWorkspaceRoot, "private.txt"),
      "file:///etc/passwd",
    ]) {
      expect(() => localPath(value)).toThrow("outside");
    }
  });

  it("rejects traversal inside a claimed remote workspace artifact", () => {
    expect(() => localPath(`${remoteWorkspaceRoot}/reports/../../private.txt`)).toThrow(
      "must stay inside",
    );
  });

  it("preserves workspace paths when no remote root is configured", () => {
    const value = path.join(localWorkspaceRoot, "report.txt");
    expect(mapCodexAppServerRemoteWorkspacePath({ value, localWorkspaceRoot })).toBe(value);
    expect(mapCodexAppServerLocalWorkspacePath({ value, localWorkspaceRoot })).toBe(value);
  });

  it("continues rejecting gateway working directories outside the workspace", () => {
    expect(() => remotePath(path.resolve("outside-workspace", "report.txt"))).toThrow(
      "outside OpenClaw workspace root",
    );
  });
});
