import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "../app/theme-branding.ts";
import {
  readAvatarGatewayContext,
  setAvatarGatewayOrigin,
} from "../lib/identity-avatar-context.ts";
import { SubagentActivity } from "../pages/chat/components/chat-subagent-activity.tsx";
import { ChatWorkingIndicator } from "../pages/chat/components/chat-working-indicator.tsx";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { PluginThemeArtwork } from "./plugin-theme-artwork.tsx";
import "../test-helpers/load-styles.ts";

function artwork() {
  return new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#4169e1"/></svg>',
    { headers: { "Content-Type": "image/svg+xml" } },
  );
}

function setupArtwork(responses: Record<string, () => Response | Promise<Response>>) {
  const previous = currentThemeBranding();
  const gateway = readAvatarGatewayContext();
  const fetch = globalThis.fetch;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) =>
      typeof input === "string" && Object.hasOwn(responses, input)
        ? Promise.resolve(responses[input]())
        : fetch(input, init),
    );
  setAvatarGatewayOrigin(location.origin);
  onTestFinished(() => {
    spy.mockRestore();
    setAvatarGatewayOrigin(gateway.origin, gateway.authTokens, gateway.resourceBasePath);
    setCurrentThemeBranding(previous);
    cleanupSolid();
  });
  return spy;
}

it.each([
  { kind: "working-indicator", size: 18 },
  { kind: "subagent", size: 16 },
])("keeps custom $kind artwork at $size pixels", async ({ kind, size }) => {
  const artworkUrl = "/__openclaw__/plugin-theme-art/synthetic/layout/icons/brand-size";
  setupArtwork({ [artworkUrl]: artwork });
  setCurrentThemeBranding(
    resolveThemeBranding({
      brandIcon: "synthetic",
      artwork: { icons: { synthetic: { url: artworkUrl } } },
    }),
  );
  const view = mountSolid(() =>
    kind === "subagent" ? (
      <SubagentActivity
        rows={[
          {
            key: "agent:main:synthetic-subagent",
            label: "Synthetic review",
            status: "running",
            listed: true,
            session: {
              key: "agent:main:synthetic-subagent",
              kind: "direct",
              updatedAt: null,
            },
          },
        ]}
      />
    ) : (
      <ChatWorkingIndicator
        part={{ kind: "reading-indicator", key: "synthetic-brand", startedAt: 1 }}
        options={{ workingIndicator: "brand", waitingApproval: true }}
      />
    ),
  );
  await vi.dynamicImportSettled();
  const icon = () => view.container.querySelector<HTMLElement>("openclaw-theme-brand-icon");
  await waitForSolid(() => expect(icon()?.querySelector("img")?.naturalWidth).toBe(256));
  expect([icon()!.clientWidth, icon()!.clientHeight]).toEqual([size, size]);
});

it("shows the fallback while replacing artwork with a different URL", async () => {
  const firstUrl = "/__openclaw__/plugin-theme-art/synthetic/reload/icons/first";
  const nextUrl = "/__openclaw__/plugin-theme-art/synthetic/reload/icons/next";
  const next = Promise.withResolvers<Response>();
  const artworkFetch = setupArtwork({ [firstUrl]: artwork, [nextUrl]: () => next.promise });
  onTestFinished(() => next.resolve(artwork()));
  const [url, setUrl] = createSignal(firstUrl);
  const view = mountSolid(() => (
    <PluginThemeArtwork url={url()} class="synthetic-hat" fallback="Loading artwork" />
  ));
  await waitForSolid(() =>
    expect(view.container.querySelector<HTMLImageElement>("img")?.naturalWidth).toBe(256),
  );
  const firstSource = view.container.querySelector("img")!.src;
  setUrl(nextUrl);
  await waitForSolid(() =>
    expect(artworkFetch.mock.calls.some(([input]) => input === nextUrl)).toBe(true),
  );
  await waitForSolid(() => {
    expect(view.container.textContent).toBe("Loading artwork");
    expect(view.container.querySelector("img")).toBeNull();
  });
  next.resolve(artwork());
  await waitForSolid(() => {
    const image = view.container.querySelector<HTMLImageElement>("img");
    expect(image?.naturalWidth).toBe(256);
    expect(image?.src).not.toBe(firstSource);
    expect(view.container.textContent).toBe("");
  });
});
