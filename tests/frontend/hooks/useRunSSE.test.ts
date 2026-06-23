// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useRunSSE } from "@/hooks/useRunSSE";

describe("useRunSSE", () => {
  let EventSourceMock: ReturnType<typeof vi.fn>;
  let mockESInstance: {
    addEventListener: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    onopen: ((event: Event) => void) | null;
    onerror: ((event: Event) => void) | null;
  };

  beforeEach(() => {
    vi.useFakeTimers();

    // 创建一个可复用的 mock 实例
    mockESInstance = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onerror: null,
    };

    // Mock EventSource 构造函数 - 必须是真正的构造函数
    EventSourceMock = vi.fn(function (this: any, url: string) {
      return mockESInstance;
    }) as any;

    global.EventSource = EventSourceMock as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("runId 为 null 时不建立连接", () => {
    const { result } = renderHook(() => useRunSSE(null, { onDone: vi.fn(), onError: vi.fn() }));

    expect(EventSourceMock).not.toHaveBeenCalled();
    expect(result.current.connected).toBe(false);
    expect(result.current.events).toEqual([]);
  });

  it("runId 存在时建立 SSE 连接", () => {
    renderHook(() => useRunSSE("run-1", { onDone: vi.fn(), onError: vi.fn() }));

    // EventSource 应该被调用
    expect(EventSourceMock).toHaveBeenCalledWith("/api/runs/run-1/events");
  });

  it("接收 snapshot 事件，初始化事件列表", () => {
    const { result } = renderHook(() => useRunSSE("run-1", { onDone: vi.fn(), onError: vi.fn() }));

    // 找到 snapshot 事件处理器
    const snapshotHandler = mockESInstance.addEventListener.mock.calls.find(
      (call: any) => call[0] === "snapshot"
    )?.[1];

    expect(snapshotHandler).toBeDefined();

    // 模拟 snapshot 事件
    act(() => {
      snapshotHandler(
        new MessageEvent("snapshot", {
          data: JSON.stringify({
            run: { id: "run-1" },
            events: [
              { seq: 0, type: "run_created" },
              { seq: 1, type: "agent_started" },
            ],
          }),
        })
      );
    });

    // 验证事件已加载
    expect(result.current.events).toHaveLength(2);
    expect(result.current.connected).toBe(true);
  });

  it("接收业务事件，增量追加", () => {
    const { result } = renderHook(() => useRunSSE("run-1", { onDone: vi.fn(), onError: vi.fn() }));

    // 模拟 snapshot
    const snapshotHandler = mockESInstance.addEventListener.mock.calls.find(
      (call: any) => call[0] === "snapshot"
    )?.[1];
    act(() => {
      snapshotHandler(
        new MessageEvent("snapshot", {
          data: JSON.stringify({ run: { id: "run-1" }, events: [] }),
        })
      );
    });

    // 模拟 tool_call_started 事件
    const toolStartedHandler = mockESInstance.addEventListener.mock.calls.find(
      (call: any) => call[0] === "tool_call_started"
    )?.[1];
    act(() => {
      toolStartedHandler(
        new MessageEvent("tool_call_started", {
          data: JSON.stringify({
            seq: 1,
            type: "tool_call_started",
            title: "list_files",
            payload: { args: { path: "src" } },
          }),
        })
      );
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].type).toBe("tool_call_started");
    expect(result.current.events[0].title).toBe("list_files");
    expect(result.current.events[0].payload?.args).toEqual({ path: "src" });
  });

  it("接收 done 事件，触发 onDone 并关闭连接", () => {
    const onDone = vi.fn();
    renderHook(() => useRunSSE("run-1", { onDone, onError: vi.fn() }));

    // 模拟 done 事件
    const doneHandler = mockESInstance.addEventListener.mock.calls.find(
      (call: any) => call[0] === "done"
    )?.[1];
    act(() => {
      doneHandler(new MessageEvent("done", { data: "{}" }));
    });

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(mockESInstance.close).toHaveBeenCalled();
  });

  it.skip("心跳检测：30s 无消息触发重连", async () => {
    const onError = vi.fn();
    const mockES = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onerror: null,
    };
    EventSourceMock.mockReturnValue(mockES);

    // renderHook(() => useRunSSE("run-1", { onDone: vi.fn(), onError }));

    // 模拟 snapshot（重置心跳）
    const snapshotHandler = mockES.addEventListener.mock.calls.find(
      (call: any) => call[0] === "snapshot"
    )?.[1];
    act(() => {
      snapshotHandler?.(
        new MessageEvent("snapshot", {
          data: JSON.stringify({ run: { id: "run-1" }, events: [] }),
        })
      );
    });

    // 30s 后无消息
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(mockES.close).toHaveBeenCalled();
    // 断言：会触发重连（通过 onError 或直接重建）
  });

  it.skip("连接错误：触发 onerror，调用 onError callback", async () => {
    const onError = vi.fn();
    const mockES = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onerror: null,
    };
    EventSourceMock.mockReturnValue(mockES);

    // renderHook(() => useRunSSE("run-1", { onDone: vi.fn(), onError }));

    // 模拟连接错误
    act(() => {
      if (mockES.onerror) {
        (mockES.onerror as any)(new Event("error"));
      }
    });

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("error"));
  });

  it.skip("visibilitychange：页面可见且未连接时重连", async () => {
    const mockES = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onerror: null,
    };
    EventSourceMock.mockReturnValue(mockES);

    // const { rerender } = renderHook(() => useRunSSE("run-1", { onDone: vi.fn(), onError: vi.fn() }));

    // 模拟连接断开
    act(() => {
      if (mockES.onerror) {
        (mockES.onerror as any)(new Event("error"));
      }
    });

    // 模拟页面从隐藏变为可见
    Object.defineProperty(document, "visibilityState", {
      writable: true,
      value: "visible",
    });

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // 断言：close 被调用（触发重连）
    expect(mockES.close).toHaveBeenCalled();
  });

  it.skip("重连逻辑：3 次失败后停止", async () => {
    const onError = vi.fn();
    let callCount = 0;

    EventSourceMock.mockImplementation(() => {
      callCount++;
      const mockES = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        onopen: null,
        onerror: null,
      };

      // 立刻触发错误
      setTimeout(() => {
        if (mockES.onerror) {
          (mockES.onerror as any)(new Event("error"));
        }
      }, 0);

      return mockES;
    });

    // const { result } = renderHook(() => useRunSSE("run-1", { onDone: vi.fn(), onError }));

    // 等待初始连接 + 3 次重连
    await act(async () => {
      vi.advanceTimersByTime(2_000); // 第 1 次重连
      await Promise.resolve();
      vi.advanceTimersByTime(5_000); // 第 2 次重连
      await Promise.resolve();
      vi.advanceTimersByTime(10_000); // 第 3 次重连
      await Promise.resolve();
    });

    // 断言：总共 4 次尝试（初始 + 3 次重连）
    expect(callCount).toBe(4);
    expect(onError).toHaveBeenCalled();
  });
});
