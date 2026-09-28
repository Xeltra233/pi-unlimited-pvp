import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { installPvpRetryHook, PvpController } from "../src/pvp-controller.js";

const proto = AgentSession.prototype as any;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function setup() {
  const controller = new PvpController();
  controller.enable("persistent");
  const cleanup = installPvpRetryHook(controller);
  cleanups.push(cleanup);
  const message = { role: "assistant", stopReason: "error", errorMessage: "fixture failure" };
  const user = { role: "user", content: "hello" };
  const session: any = { agent: { state: { messages: [user, message] } } };
  return { controller, cleanup, session, message, user };
}

describe("native retry compatibility", () => {
  it("uses durable omission on pi 0.87+ instead of only changing memory", async () => {
    const { controller, session, message, user } = setup();
    session._omitRecoveryAttempt = vi.fn(() => { session.agent.state.messages = [user]; });
    expect(await proto._prepareRetry.call(session, message)).toBe(true);
    expect(session._omitRecoveryAttempt).toHaveBeenCalledExactlyOnceWith(message);
    expect(session.agent.state.messages).toEqual([user]);
    expect(controller.currentAttempt).toBe(1);
  });
  it("retains the in-memory path on pi 0.84–0.86", async () => {
    const { session, message, user } = setup();
    expect(await proto._prepareRetry.call(session, message)).toBe(true);
    expect(session.agent.state.messages).toEqual([user]);
  });
  it("does not hide a projection failure", async () => {
    const { session, message } = setup();
    session._omitRecoveryAttempt = () => { throw new Error("projection failed"); };
    await expect(proto._prepareRetry.call(session, message)).rejects.toThrow("projection failed");
  });
  it("does not continue after /pvp off during the event-loop yield", async () => {
    const { controller, session, message } = setup();
    const pending = proto._prepareRetry.call(session, message);
    controller.disable();
    expect(await pending).toBe(false);
  });
  it("honors the pi 0.86+ run-abort flag before modifying context", async () => {
    const { controller, session, message } = setup();
    session._agentRunAbortRequested = true;
    expect(await proto._prepareRetry.call(session, message)).toBe(false);
    expect(session.agent.state.messages).toHaveLength(2);
    expect(controller.currentAttempt).toBe(0);
  });
  it("aborts the native retry wait and releases its controller", async () => {
    const { controller, session, message } = setup();
    const pending = proto._prepareRetry.call(session, message);
    session._retryAbortController.abort();
    expect(await pending).toBe(false);
    expect(session._retryAbortController).toBeUndefined();
    expect(controller.currentAttempt).toBe(0);
  });
  it("old cleanup cannot uninstall a newer installation", () => {
    const { cleanup } = setup();
    const next = new PvpController();
    next.enable("one");
    cleanups.push(installPvpRetryHook(next));
    const current = proto._prepareRetry;
    cleanup();
    expect(proto._prepareRetry).toBe(current);
  });
  it("cleanup preserves hooks installed afterward by other extensions", () => {
    const original = proto._prepareRetry;
    const { cleanup } = setup();
    const later = async () => false;
    proto._prepareRetry = later;
    try { cleanup(); expect(proto._prepareRetry).toBe(later); }
    finally { proto._prepareRetry = original; }
  });
});
