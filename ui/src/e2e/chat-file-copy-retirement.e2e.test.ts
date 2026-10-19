import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openFileActions, selectFileAction } from "./chat-file-actions.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "File copy retirement" });

declare global {
  interface Window {
    fileCopyProof: {
      nativeWrites: string[];
      fallbacks: string[];
      reject?: () => void;
      resolve?: () => void;
    };
  }
}

function fileResponse(content: string) {
  return {
    root: "/workspace",
    file: {
      previewKind: "text",
      contentEncoding: "utf8",
      content,
      kind: "read",
      missing: false,
      name: "notes.txt",
      path: "notes.txt",
      workspacePath: "notes.txt",
    },
  };
}

suite.define(() => {
  it.each(
    (["current", "close", "replacement"] as const).flatMap((lifecycle) =>
      (["path", "contents"] as const).map((action) => ({ lifecycle, action })),
    ),
  )(
    "scopes $action copy fallback to its $lifecycle file presentation",
    async ({ lifecycle, action }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        await page.clock.install();
        await page.addInitScript(() => {
          window.fileCopyProof = { nativeWrites: [], fallbacks: [] };
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: (text: string) => {
                window.fileCopyProof.nativeWrites.push(text);
                return new Promise<void>((resolve, reject) => {
                  window.fileCopyProof.resolve = resolve;
                  window.fileCopyProof.reject = () =>
                    reject(new Error("Synthetic clipboard rejection"));
                });
              },
            },
          });
          document.execCommand = (command: string) => {
            if (command !== "copy") {
              throw new Error(`Unexpected clipboard command: ${command}`);
            }
            const selected = document.activeElement;
            window.fileCopyProof.fallbacks.push(
              selected instanceof HTMLTextAreaElement ? selected.value : "",
            );
            return true;
          };
        });
        const gateway = await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Review `notes.txt`." }],
              timestamp: 1,
            },
          ],
          methodResponses: {
            "sessions.files.get": fileResponse("Synthetic file copy content"),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
        const panel = page.locator("openclaw-chat-detail-panel:visible");
        await panel.locator(".cm-content").waitFor({ state: "visible" });
        const copy = () =>
          selectFileAction(panel, action === "path" ? "Copy path" : "Copy file contents");
        const copied = () =>
          panel.getByRole(action === "path" ? "menuitem" : "button", {
            name: "Copied!",
            exact: true,
          });
        await copy();
        await page.waitForFunction(() => window.fileCopyProof.nativeWrites.length === 1);
        const expected = action === "path" ? "notes.txt" : "Synthetic file copy content";
        expect(await page.evaluate(() => window.fileCopyProof.nativeWrites)).toEqual([expected]);
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "copy-pending.png"),
        });
        if (lifecycle === "close") {
          await page.getByRole("button", { name: "Close tab: notes.txt", exact: true }).click();
          await expect.poll(() => page.locator(".sidebar-file-view:visible").count()).toBe(0);
        } else if (lifecycle === "replacement") {
          await gateway.setMethodResponse("sessions.files.get", fileResponse("Updated file bytes"));
          await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
          await expect
            .poll(() => panel.locator(".cm-content").textContent())
            .toContain("Updated file bytes");
          expect(await gateway.getRequests("sessions.files.get")).toHaveLength(2);
        }
        // Keep transient feedback alive while proof capture crosses host I/O boundaries.
        const pendingAt = await page.evaluate(() => Date.now());
        await page.clock.pauseAt(pendingAt + 1_000);
        await page.evaluate(() => window.fileCopyProof.reject!());
        if (lifecycle === "current") {
          await page.waitForFunction(() => window.fileCopyProof.fallbacks.length === 1);
          expect(await page.evaluate(() => window.fileCopyProof.fallbacks)).toEqual([expected]);
          if (action === "path") {
            await openFileActions(panel);
          }
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, "copy-feedback.png"),
          });
          await copied().waitFor({ state: "visible" });
        }
        const evidence = await page.evaluate(() => ({
          nativeWrites: window.fileCopyProof.nativeWrites,
          fallbacks: window.fileCopyProof.fallbacks,
        }));
        await writeFile(
          path.join(suite.artifactDir, "clipboard-result.json"),
          JSON.stringify({ lifecycle, action, ...evidence }, null, 2),
        );
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "copy-settled.png"),
        });
        expect(evidence.fallbacks).toEqual(lifecycle === "current" ? [expected] : []);
        if (lifecycle === "current") {
          expect(await copied().count()).toBe(1);
          // Retire the first attempt's feedback before proving native success.
          await page.clock.fastForward(1_500);
          await copy();
          await page.waitForFunction(() => window.fileCopyProof.nativeWrites.length === 2);
          await page.evaluate(() => window.fileCopyProof.resolve!());
          if (action === "path") {
            await openFileActions(panel);
          }
          await copied().waitFor({ state: "visible" });
          const nativeSuccess = await page.evaluate(() => ({
            nativeWrites: window.fileCopyProof.nativeWrites,
            fallbacks: window.fileCopyProof.fallbacks,
          }));
          expect(nativeSuccess.nativeWrites).toEqual([expected, expected]);
          expect(nativeSuccess.fallbacks).toEqual([expected]);
          await writeFile(
            path.join(suite.artifactDir, "native-success.json"),
            JSON.stringify(nativeSuccess, null, 2),
          );
        } else {
          expect(await page.locator(".sidebar-file-view:visible button.copied").count()).toBe(0);
          expect(await page.locator(".file-view__save-notice:visible").count()).toBe(0);
        }
      });
    },
  );
});
