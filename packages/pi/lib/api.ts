// Adapted from @upstash/context7-mcp (packages/mcp/src/lib/api.ts) — kept
// minimal for pi: no proxy/CA-cert handling (pi controls the HTTP runtime),
// no per-request client context (pi passes through env). Keep wire format
// and error messages aligned with MCP.

import type { SearchResponse } from "./types";

const BASE_URL = "https://context7.com/api";
// Foundry's trusted Pi process must not wait indefinitely or consume an
// unbounded response from a remote documentation service. Agent-selected query
// text is bounded here; the seeded Foundry health probe uses only fixed public
// documentation strings (normal Pi usage remains the developer's choice).
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_QUERY_CHARS = 800;
const MAX_RESULT_BYTES = 128 * 1024;

function authHeaders(): Record<string, string> {
  const apiKey = process.env.CONTEXT7_API_KEY;
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function checkedInput(value: string, name: string): string {
  if (!value.trim() || value.length > MAX_QUERY_CHARS || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(
      `Invalid Context7 ${name}: nonempty public-doc text of at most ${MAX_QUERY_CHARS} characters is required`
    );
  }
  return value;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_RESULT_BYTES) throw new Error("Context7 response exceeded the 128 KiB limit");
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function parseErrorResponse(response: Response): Promise<string> {
  // A failed/aborted body read is not a usable HTTP error message. Only a
  // malformed JSON payload may fall back to the status-based diagnostic.
  const text = await boundedText(response);
  try {
    const json = JSON.parse(text) as { message?: unknown };
    if (typeof json.message === "string") return json.message.slice(0, 300);
  } catch {
    // The status below remains useful if the error body is not JSON.
  }

  const hasKey = Boolean(process.env.CONTEXT7_API_KEY);
  if (response.status === 429) {
    return hasKey
      ? "Rate limited or quota exceeded. Upgrade your plan at https://context7.com/plans for higher limits."
      : "Rate limited or quota exceeded. Create a free API key at https://context7.com/dashboard for higher limits.";
  }
  if (response.status === 404) {
    return "The library you are trying to access does not exist. Please try with a different library ID.";
  }
  if (response.status === 401) {
    return "Invalid API key. Please check your API key. API keys should start with 'ctx7sk' prefix.";
  }
  return `Request failed with status ${response.status}. Please try again later.`;
}

export async function searchLibraries(
  query: string,
  libraryName: string,
  signal?: AbortSignal
): Promise<SearchResponse> {
  const url = new URL(`${BASE_URL}/v2/libs/search`);
  url.searchParams.set("query", checkedInput(query, "query"));
  url.searchParams.set("libraryName", checkedInput(libraryName, "library name"));

  const response = await fetch(url, { headers: authHeaders(), signal: requestSignal(signal) });
  if (!response.ok) {
    return { results: [], error: await parseErrorResponse(response) };
  }
  return JSON.parse(await boundedText(response)) as SearchResponse;
}

export async function fetchLibraryContext(
  query: string,
  libraryId: string,
  signal?: AbortSignal
): Promise<string> {
  const url = new URL(`${BASE_URL}/v2/context`);
  url.searchParams.set("query", checkedInput(query, "query"));
  url.searchParams.set("libraryId", checkedInput(libraryId, "library ID"));

  const response = await fetch(url, { headers: authHeaders(), signal: requestSignal(signal) });
  if (!response.ok) {
    return parseErrorResponse(response);
  }

  const text = await boundedText(response);
  if (!text) {
    return "Documentation not found or not finalized for this library. This might have happened because you used an invalid Context7-compatible library ID. To get a valid Context7-compatible library ID, use the 'resolve-library-id' with the package name you wish to retrieve documentation for.";
  }
  return text;
}
