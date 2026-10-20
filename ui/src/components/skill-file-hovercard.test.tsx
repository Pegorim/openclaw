/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { createSkillFileHovercard } from "./skill-file-hovercard.tsx";

const file = { path: "/s/SKILL.md", name: "s", content: "---\nname: s\n---\n# Skill\n" };
const card = () => document.querySelector(".skill-file-hovercard");
const source = () => document.querySelector(".skill-file-hovercard__source");

function setup() {
  const request = createGatewayRequestMock(async () => file);
  let changeAgent!: (value: string) => void;
  const view = mountSolid(() => {
    const [agent, setAgent] = createSignal("main");
    changeAgent = setAgent;
    const ref = createSkillFileHovercard({
      client: createTestGatewayClient(request),
      get agentId() {
        return agent();
      },
      sessionKey: "agent:main:main",
      onOpenFile: vi.fn(),
    });
    return (
      <div ref={ref}>
        <a href="#" data-file-path={file.path}>
          {file.name}
        </a>
        <a href="#" data-file-path="README.md">
          README
        </a>
      </div>
    );
  });
  flush();
  return { ...view, request, changeAgent, anchor: view.getByText(file.name) };
}

async function focus(anchor: HTMLElement) {
  anchor.focus();
  await waitForSolid(() => expect(source()).not.toBeNull());
}

it("loads on intent, renders source as text, and rereads after dismissal", async () => {
  const { anchor, request } = setup();
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValueOnce({ ...file, content: "<img src=x onerror=alert(1)>" });
  await focus(anchor);
  expect(source()?.textContent).toContain("<img src=x");
  expect(source()?.querySelector("img")).toBeNull();
  anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(card()).toBeNull();
  anchor.blur();
  await focus(anchor);
  expect(request).toHaveBeenCalledTimes(2);
  expect(source()?.textContent).toContain("# Skill");
});

it("retires pending requests when the agent changes or the trigger is removed", async () => {
  const { changeAgent, anchor, request } = setup();
  const pending = Promise.withResolvers<typeof file>();
  request.mockImplementation(() => pending.promise);
  anchor.focus();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const signal = request.mock.calls[0]?.[2]?.signal;
  changeAgent("other");
  flush();
  expect(signal?.aborted).toBe(true);
  pending.resolve(file);
  await Promise.resolve();
  expect(card()).toBeNull();
  anchor.blur();
  await focus(anchor);
  anchor.remove();
  await waitForSolid(() => expect(card()).toBeNull());
});

it("keeps ordinary files untouched and exposes a retry after a failed read", async () => {
  const { anchor, request, getByText, getByRole } = setup();
  getByText("README").focus();
  expect(request).not.toHaveBeenCalled();
  request.mockRejectedValueOnce(new Error("not installed"));
  anchor.click();
  await waitForSolid(() => expect(card()?.textContent).toContain("Skill file unavailable"));
  getByRole("button", { name: "Retry" }).click();
  await waitForSolid(() => expect(source()).not.toBeNull());
  expect(request).toHaveBeenCalledTimes(2);
});
