import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLibraryContext, searchLibraries } from "../lib/api";

// Observe the actual fetch request, not a model's description of a tool call.
afterEach(() => vi.unstubAllGlobals());

describe("bounded Context7 transport", () => {
  it("uses only Context7's fixed endpoint and honors the caller's abort", async () => {
    const fetchMock = vi.fn(
      async (_url: URL, _options: RequestInit) =>
        new Response(JSON.stringify({ results: [{ id: "/facebook/react" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const abort = new AbortController();
    expect((await searchLibraries("React hooks", "React", abort.signal)).results).toHaveLength(1);
    const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe("https://context7.com");
    expect(url.pathname).toBe("/api/v2/libs/search");
    expect(url.searchParams.get("query")).toBe("React hooks");
    expect(options.signal?.aborted).toBe(false);
    abort.abort();
    expect(options.signal?.aborted).toBe(true);
  });

  it("rejects long or control-character queries before transmitting any bytes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchLibraryContext("private\nfile", "/facebook/react")).rejects.toThrow(
      /Invalid Context7 query/
    );
    await expect(searchLibraries("x".repeat(801), "React")).rejects.toThrow(
      /Invalid Context7 query/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an oversized documentation response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(128 * 1024 + 1), { status: 200 }))
    );
    await expect(fetchLibraryContext("What is useEffect?", "/facebook/react")).rejects.toThrow(
      /response exceeded/
    );
  });

  it("cancels an in-flight query when the caller aborts", async () => {
    const fetchMock = vi.fn(
      (_url: URL, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const abort = new AbortController();
    const pending = fetchLibraryContext("What is useEffect?", "/facebook/react", abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not mistake cancellation of an HTTP error body for a completed tool result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, options: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            options.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("cancelled", "AbortError")),
              { once: true }
            );
          },
        });
        return new Response(body, { status: 503 });
      })
    );
    const abort = new AbortController();
    const pending = searchLibraries("React hooks", "React", abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns bounded error text without treating HTTP errors as healthy results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "not ready" }), { status: 503 }))
    );
    expect(await searchLibraries("React hooks", "React")).toMatchObject({
      results: [],
      error: "not ready",
    });
  });
});
