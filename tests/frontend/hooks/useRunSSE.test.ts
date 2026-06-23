// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchEventSourceInit } from "@microsoft/fetch-event-source";
import { useRunSSE } from "@/hooks/useRunSSE";

const { fetchEventSourceMock } = vi.hoisted(() => ({
  fetchEventSourceMock: vi.fn(),
}));

vi.mock("@microsoft/fetch-event-source", async () => {
  const actual = await vi.importActual<typeof import("@microsoft/fetch-event-source")>(
    "@microsoft/fetch-event-source",
  );
  return {
    ...actual,
    fetchEventSource: fetchEventSourceMock,
  };
});

function latestInit(): FetchEventSourceInit {
  return fetchEventSourceMock.mock.calls.at(-1)?.[1] as FetchEventSourceInit;
}

async function openConnection() {
  await act(async () => {
    await latestInit().onopen?.(
      new Response(null, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }),
    );
  });
}

describe("useRunSSE", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchEventSourceMock.mockReset();
    fetchEventSourceMock.mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("runId 为 null 时不建立连接", () => {
    const { result } = renderHook(() => useRunSSE(null, { onDone: vi.fn(), onError: vi.fn() }));

    expect(fetchEventSourceMock).not.toHaveBeenCalled();
    expect(result.current.connected).toBe(false);
    expect(result.current.events).toEqual([]);
  });

  it("runId 存在时用 POST 建立 SSE 连接", () => {
    renderHook(() => useRunSSE("run-1", { onDone: vi.fn(), onError: vi.fn() }));

    expect(fetchEventSourceMock).toHaveBeenCalledWith(
      "/api/runs/run-1/events",
      expect.objectContaining({
        method: "POST",
        headers: { accept: "text/event-stream" },
        openWhenHidden: true,
      }),
    );
  });

  it("接收 snapshot 事件，初始化事件列表", async () => {
    const { result } = renderHook(() => useRunSSE("run-1", { onDone: vi.fn(), onError: vi.fn() }));
    await openConnection();

    act(() => {
      latestInit().onmessage?.({
        id: "",
        event: "snapshot",
        data: JSON.stringify({
          run: { id: "run-1" },
          events: [
            { seq: 0, type: "run_created", createdAt: "2026-01-01T00:00:00.000Z" },
            { seq: 1, type: "agent_started", createdAt: "2026-01-01T00:00:01.000Z" },
          ],
        }),
      });
    });

    expect(result.current.events).toHaveLength(2);
    expect(result.current.connected).toBe(true);
  });

  it("接收业务事件，增量追加", async () => {
    const { result } = renderHook(() => useRunSSE("run-1", { onDone: vi.fn(), onError: vi.fn() }));
    await openConnection();

    act(() => {
      latestInit().onmessage?.({
        id: "",
        event: "snapshot",
        data: JSON.stringify({ run: { id: "run-1" }, events: [] }),
      });
      latestInit().onmessage?.({
        id: "",
        event: "tool_call_started",
        data: JSON.stringify({
          seq: 1,
          type: "tool_call_started",
          title: "list_files",
          payload: { args: { path: "src" } },
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].type).toBe("tool_call_started");
    expect(result.current.events[0].title).toBe("list_files");
    expect(result.current.events[0].payload?.args).toEqual({ path: "src" });
  });

  it("接收 done 事件，触发 onDone 并断开连接", async () => {
    const onDone = vi.fn();
    const { result } = renderHook(() => useRunSSE("run-1", { onDone, onError: vi.fn() }));
    await openConnection();

    act(() => {
      latestInit().onmessage?.({ id: "", event: "done", data: "{}" });
    });

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.current.connected).toBe(false);
    expect((latestInit().signal as AbortSignal).aborted).toBe(true);
  });

  it("连接错误后自动重连，最多重试 3 次", async () => {
    const onError = vi.fn();
    fetchEventSourceMock.mockRejectedValue(new Error("network down"));

    renderHook(() => useRunSSE("run-1", { onDone: vi.fn(), onError }));

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchEventSourceMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchEventSourceMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchEventSourceMock).toHaveBeenCalledTimes(4);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(onError).toHaveBeenCalledWith("SSE connection error after 3 retries");
  });
});
