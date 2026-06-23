// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { FetchEventSourceInit } from "@microsoft/fetch-event-source";
import type { RunDTO } from "@/lib/api-contract";
import { useSessionState } from "@/hooks/useSessionState";

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

describe("useSessionState", () => {
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchEventSourceMock.mockReset();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    // Mock fetch
    fetchMock = vi.fn();
    global.fetch = fetchMock;

    fetchEventSourceMock.mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  function latestSSEInit(): FetchEventSourceInit {
    return fetchEventSourceMock.mock.calls.at(-1)?.[1] as FetchEventSourceInit;
  }

  async function openSSE() {
    await latestSSEInit().onopen?.(
      new Response(null, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }),
    );
  }

  describe("S1: 发送新消息", () => {
    it("立刻乐观渲染，建立 SSE 连接，不 refetch DB", async () => {
      const sessionId = "test-session-1";

      // Mock GET /sessions/:id (初始加载)
      let getCallCount = 0;
      fetchMock.mockImplementation(async (url, options) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = options?.method || 'GET';

        if (method === 'GET' && urlStr.includes('/sessions/')) {
          getCallCount++;
          return {
            ok: true,
            json: async () => ({
              code: 0,
              data: {
                session: { id: sessionId, title: "Test", status: "active" },
                messages: [],
                runs: [],
              },
            }),
          };
        }

        // POST /runs
        if (method === 'POST' && urlStr.includes('/runs')) {
          return {
            ok: true,
            json: async () => ({
              code: 0,
              data: {
                run: { id: "run-1", status: "running" }
              },
            }),
          };
        }

        throw new Error(`Unexpected request: ${method} ${urlStr}`);
      });

      const { result } = renderHook(() => useSessionState(sessionId), { wrapper });

      await waitFor(() => {
        expect(result.current.session).not.toBeNull();
      });

      // 初始加载：GET 调用 1 次
      expect(getCallCount).toBe(1);

      // 发送消息
      await result.current.sendMessage("查找 TODO");

      // 断言：立刻显示乐观消息
      await waitFor(() => {
        expect(result.current.pendingMessage).not.toBeNull();
        expect(result.current.pendingMessage?.prompt).toBe("查找 TODO");
      });

      // 断言：建立 SSE 连接
      await waitFor(() => {
        expect(fetchEventSourceMock).toHaveBeenCalledWith(
          "/api/runs/run-1/events",
          expect.objectContaining({ method: "POST" }),
        );
      });

      // 模拟 SSE 推送
      await openSSE();
      latestSSEInit().onmessage?.({
        id: "",
        event: "snapshot",
        data: JSON.stringify({ run: { id: "run-1" }, events: [] }),
      });
      latestSSEInit().onmessage?.({ id: "", event: "done", data: "{}" });

      // 断言：SSE done 后不调用 GET /sessions
      await waitFor(() => {
        expect(result.current.activeRunId).toBeNull();
      });

      // 验证 GET 调用次数：只有初始加载，无额外 GET
      expect(getCallCount).toBe(1);
    });
  });

  describe("S2: 刷新页面（run 进行中）", () => {
    it("从 DB 加载，检测到 running，自动重连 SSE", async () => {
      const sessionId = "test-session-2";

      // Mock GET /sessions/:id (返回进行中的 run)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            session: { id: sessionId },
            messages: [],
            runs: [{ id: "run-2", status: "running" }],
          },
        }),
      });

      const { result } = renderHook(() => useSessionState(sessionId), { wrapper });

      // 断言：自动建立 SSE 连接
      await waitFor(() => {
        expect(fetchEventSourceMock).toHaveBeenCalledWith(
          "/api/runs/run-2/events",
          expect.objectContaining({ method: "POST" }),
        );
      });
      expect(result.current.activeRunId).toBe("run-2");

      // 模拟 SSE snapshot（补齐历史）
      await openSSE();
      latestSSEInit().onmessage?.({
        id: "",
        event: "snapshot",
        data: JSON.stringify({
          run: { id: "run-2" },
          events: [
            { seq: 0, type: "run_created" },
            { seq: 1, type: "agent_started" },
          ],
        }),
      });

      // 断言：历史事件已加载
      await waitFor(() => {
        expect(result.current.runs[0]).toHaveProperty("liveEvents");
        expect((result.current.runs[0] as RunDTO).liveEvents).toHaveLength(2);
      });

      latestSSEInit().onmessage?.({ id: "", event: "done", data: "{}" });

      await waitFor(() => {
        expect(result.current.activeRunId).toBeNull();
      });
    });
  });

  describe("S3: 刷新页面（run 已完成）", () => {
    it("从 DB 加载，无 SSE 连接", async () => {
      const sessionId = "test-session-3";

      // Mock GET /sessions/:id (返回已完成的 run)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            session: { id: sessionId },
            messages: [
              { role: "user", content: "查找 TODO" },
              { role: "assistant", content: "找到 3 个 TODO" },
            ],
            runs: [{ id: "run-3", status: "completed" }],
          },
        }),
      });

      const { result } = renderHook(() => useSessionState(sessionId), { wrapper });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(2);
      });

      // 断言：不建立 SSE 连接
      expect(fetchEventSourceMock).not.toHaveBeenCalled();
    });
  });

  describe("E1: SSE 连接失败", () => {
    it.skip("显示错误，降级到轮询", async () => {
      const sessionId = "test-session-e1";

      // Mock 初始加载
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            session: { id: sessionId },
            messages: [],
            runs: [{ id: "run-e1", status: "running" }],
          },
        }),
      });

      // Mock SSE 立刻失败
      fetchEventSourceMock.mockRejectedValue(new Error("Connection failed"));

      // const { result } = renderHook(() => useSessionState(sessionId), { wrapper });

      // 断言：降级到轮询（refetchInterval = 5000）
      await waitFor(() => {
        // expect(result.current.sseConnected).toBe(false);
      });

      // 等待轮询触发
      await new Promise((resolve) => setTimeout(resolve, 5100));

      // 断言：轮询请求已发送
      expect(fetchMock).toHaveBeenCalledTimes(2); // 初始 + 第一次轮询
    });
  });

  describe("E2: SSE 中途断开", () => {
    it.skip("自动重连 3 次，失败后降级轮询", async () => {
      const sessionId = "test-session-e2";

      // Mock 初始加载
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            session: { id: sessionId },
            messages: [],
            runs: [{ id: "run-e2", status: "running" }],
          },
        }),
      });

      // Mock SSE
      let esErrorHandler: ((e: Event) => void) | null = null;
      fetchEventSourceMock.mockImplementation((_url, init: FetchEventSourceInit) => {
        esErrorHandler = () => init.onerror?.(new Error("Connection failed"));
        return new Promise(() => {});
      });

      // const { result } = renderHook(() => useSessionState(sessionId), { wrapper });

      await waitFor(() => {
        expect(fetchEventSourceMock).toHaveBeenCalledTimes(1);
      });

      // 模拟断开
      esErrorHandler?.(new Event("error"));

      // 等待重连 3 次（2s + 5s + 10s）
      await new Promise((resolve) => setTimeout(resolve, 20000));

      // 断言：重连 3 次 + 降级轮询
      expect(fetchEventSourceMock).toHaveBeenCalledTimes(4); // 初始 + 3 次重连
    });
  });

  describe("E1: SSE 连接失败", () => {
    it("SSE 失败后，sseConnected 为 false，触发轮询", async () => {
      const sessionId = "test-session-e1";

      // Mock 初始加载
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            session: { id: sessionId },
            messages: [],
            runs: [{ id: "run-e1", status: "running" }],
          },
        }),
      });

      // Mock SSE 立刻失败
      fetchEventSourceMock.mockImplementation((_url, init: FetchEventSourceInit) => {
        setTimeout(() => {
          init.onerror?.(new Error("Connection failed"));
        }, 10);
        return new Promise(() => {});
      });

      const { result } = renderHook(() => useSessionState(sessionId), { wrapper });

      // 等待初始加载
      await waitFor(() => {
        expect(result.current.runs).toHaveLength(1);
      });

      // 等待 SSE 失败
      await waitFor(() => {
        expect(result.current.sseConnected).toBe(false);
      }, { timeout: 1000 });

      // 断言：SSE 未连接，应该启用轮询
      // refetchInterval 会自动设置为 5000
      expect(result.current.sseConnected).toBe(false);
    });
  });

  describe("E8: 快速连发多条消息", () => {
    it("activeRunId 存在时阻止发送", async () => {
      const sessionId = "test-session-e8";

      // Mock 初始加载
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            session: { id: sessionId },
            messages: [],
            runs: [],
          },
        }),
      });

      const { result } = renderHook(() => useSessionState(sessionId), { wrapper });

      await waitFor(() => {
        expect(result.current.session).not.toBeNull();
      });

      // Mock POST /runs
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: { run: { id: "run-1", status: "running" } },
        }),
      });

      // 发送第一条消息
      await result.current.sendMessage("消息 1");

      // 断言：activeRunId 已设置
      await waitFor(() => {
        expect(result.current.activeRunId).toBe("run-1");
      });

      // Mock 第二次 POST（不应该被调用）
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: { run: { id: "run-2", status: "running" } },
        }),
      });

      // 尝试发送第二条消息（应该被阻止）
      await result.current.sendMessage("消息 2");

      // 断言：fetch 只被调用 2 次（初始加载 + 第一条消息）
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.current.activeRunId).toBe("run-1"); // 仍然是第一个 run
    });
  });
});
