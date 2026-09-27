import { resolve4, resolve6 } from "node:dns/promises";
import { EventEmitter } from "node:events";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { PassThrough } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ resolve4: vi.fn(), resolve6: vi.fn() }));
vi.mock("node:http", () => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));

const replies: {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  hold?: boolean;
  holdHeaders?: boolean;
}[] = [];
const opened: PassThrough[] = [];
function reply(
  status: number,
  headers: Record<string, string> = { "content-type": "text/plain" },
  body: string | Buffer = "",
) {
  replies.push({ status, headers, body });
}
function transport() {
  const call = vi.fn(
    (
      _url: string | URL,
      options: RequestOptions,
      onResponse?: (res: IncomingMessage) => void,
    ): ClientRequest => {
      let stream: PassThrough | undefined;
      const req = Object.assign(new EventEmitter(), {
        end() {
          const next = replies.shift();
          if (!next) throw new Error("Missing local response");
          if (next.holdHeaders) return;
          stream = Object.assign(new PassThrough(), {
            statusCode: next.status,
            headers: next.headers ?? {},
          });
          const res = stream;
          opened.push(res);
          queueMicrotask(() => {
            onResponse?.(res as unknown as IncomingMessage);
            if (!next.hold) res.end(next.body ?? "");
          });
        },
        destroy() {
          stream?.destroy();
          req.emit("error", Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
        },
      });
      options.signal?.addEventListener("abort", () => req.destroy(), { once: true });
      return req as unknown as ClientRequest;
    },
  );
  vi.mocked(httpsRequest).mockImplementation(call);
  vi.mocked(httpRequest).mockImplementation(call);
  return call;
}
import { guardedRequest } from "./guardedRequest.js";

describe("guardedRequest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    replies.length = 0;
    opened.length = 0;
    transport();
    vi.mocked(resolve4).mockResolvedValue(["8.8.8.8"]);
    vi.mocked(resolve6).mockResolvedValue(["2001:4860:4860::8888"]);
  });

  it("refuses unsafe IP literals, alternate numeric forms and ports", async () => {
    const blocked = [
      "http://127.1/",
      "https://10.1.2.3/",
      "https://100.64.1.1/",
      "https://169.254.169.254/",
      "https://172.16.0.1/",
      "https://192.168.1.1/",
      "https://192.0.0.9/",
      "https://192.0.0.1/",
      "https://192.0.2.1/",
      "https://198.18.0.1/",
      "https://224.0.0.1/",
      "https://[::1]/",
      "https://[fc00::1]/",
      "https://[fe80::1]/",
      "https://[ff02::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[2001:db8::1]/",
      "https://[2001::1]/",
      "https://[2001:0::1]/",
      "https://[2001:1ff::1]/",
      "https://[2002::1]/",
      "https://[3fff::1]/",
      "https://example.com:8443/",
      "http://example.com:8080/",
    ];
    for (const url of blocked) {
      await expect(guardedRequest(url, { maxBytes: 100 })).rejects.toThrow(/refused/i);
    }
  });

  it("refuses hosts outside an explicit allowlist", async () => {
    await expect(
      guardedRequest("https://example.com/", {
        maxBytes: 100,
        allowedHosts: ["html.duckduckgo.com"],
      }),
    ).rejects.toThrow(/refused/i);
  });

  it("fails closed if either DNS family has an unsafe answer or a DNS error", async () => {
    vi.mocked(resolve4).mockResolvedValueOnce(["8.8.8.8", "10.0.0.1"]);
    await expect(guardedRequest("https://example.com/", { maxBytes: 100 })).rejects.toThrow(
      /refused/i,
    );
    vi.mocked(resolve6).mockResolvedValueOnce(["2001:4860::8888", "fc00::1"]);
    await expect(guardedRequest("https://example.com/", { maxBytes: 100 })).rejects.toThrow(
      /refused/i,
    );
    for (const address of ["2001::1", "2001:0::1", "2001:1ff::1", "2002::1", "3fff::1"]) {
      vi.mocked(resolve6).mockResolvedValueOnce(["2001:4860::8888", address]);
      await expect(guardedRequest("https://example.com/", { maxBytes: 100 })).rejects.toThrow(
        /refused/i,
      );
    }
    vi.mocked(resolve6).mockRejectedValueOnce(new Error("private DNS detail"));
    await expect(guardedRequest("https://example.com/", { maxBytes: 100 })).rejects.toThrow(/DNS/i);
  });
  it("upgrades HTTP to HTTPS and pins a public DNS answer without changing Host or TLS name", async () => {
    reply(200, { "content-type": "text/html; charset=utf-8" }, "<p>ok</p>");
    const result = await guardedRequest("http://example.com/old", { maxBytes: 100 });
    expect(result).toEqual({
      url: "https://example.com/old",
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<p>ok</p>",
      downloadTruncated: false,
    });
    expect(httpRequest).not.toHaveBeenCalled();
    const [url, options] = vi.mocked(httpsRequest).mock.calls[0];
    expect(url.toString()).toBe("https://example.com/old");
    expect(options).toMatchObject({
      servername: "example.com",
      headers: { Host: "example.com", "Accept-Encoding": "identity" },
    });
    const lookup = options.lookup;
    expect(lookup).toBeTypeOf("function");
    if (lookup) {
      await new Promise<void>((resolve, reject) =>
        lookup("example.com", { all: true }, (error, addresses) => {
          if (error) return reject(error);
          expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
          resolve();
        }),
      );
    }
  });

  it("validates redirects and follows relative locations at most ten times", async () => {
    reply(302, { location: "/new" });
    reply(200, { "content-type": "text/plain" }, "done");
    expect((await guardedRequest("https://example.com/start", { maxBytes: 20 })).url).toBe(
      "https://example.com/new",
    );
    for (let i = 0; i < 11; i++) reply(302, { location: "/again" });
    await expect(guardedRequest("https://example.com/", { maxBytes: 20 })).rejects.toThrow(
      /redirect/i,
    );
    expect(opened.every((stream) => stream.destroyed)).toBe(true);
    reply(302, { location: "https://127.0.0.1/" });
    await expect(guardedRequest("https://example.com/", { maxBytes: 20 })).rejects.toThrow(
      /refused/i,
    );
    reply(302, { location: "https://evil.example/" });
    await expect(
      guardedRequest("https://example.com/", { maxBytes: 20, allowedHosts: ["example.com"] }),
    ).rejects.toThrow(/refused/i);
  });

  it("keeps only the byte cap and refuses unsupported or compressed media", async () => {
    reply(200, { "content-type": "text/plain" }, "a".repeat(200));
    expect(await guardedRequest("https://example.com/", { maxBytes: 10 })).toMatchObject({
      body: "a".repeat(10),
      downloadTruncated: true,
    });
    expect(opened[0].destroyed).toBe(true);
    reply(200, { "content-type": "application/pdf" }, "private pdf");
    await expect(guardedRequest("https://example.com/", { maxBytes: 10 })).rejects.toThrow(
      /content type/i,
    );
    reply(200, { "content-type": "text/plain", "content-encoding": "zstd" }, "data");
    await expect(guardedRequest("https://example.com/", { maxBytes: 10 })).rejects.toThrow(
      /encoding/i,
    );
  });

  it("reads a gzip response that ignores the identity request", async () => {
    reply(200, { "content-type": "text/plain", "content-encoding": "gzip" }, gzipSync("hello"));
    expect(await guardedRequest("https://example.com/", { maxBytes: 100 })).toEqual({
      url: "https://example.com/",
      status: 200,
      contentType: "text/plain",
      body: "hello",
      downloadTruncated: false,
    });
  });

  it("reads a Brotli response with a case-insensitive encoding", async () => {
    reply(
      200,
      { "content-type": "text/plain", "content-encoding": " Br " },
      brotliCompressSync("hello"),
    );
    expect((await guardedRequest("https://example.com/", { maxBytes: 100 })).body).toBe("hello");
  });

  it("reads a deflate response before decoding its declared charset", async () => {
    reply(
      200,
      { "content-type": "text/plain; charset=iso-8859-1", "content-encoding": "deflate" },
      deflateSync(Buffer.from([0x63, 0x61, 0x66, 0xe9])),
    );
    expect((await guardedRequest("https://example.com/", { maxBytes: 100 })).body).toBe("café");
  });

  it("returns only a bounded decoded gzip prefix", async () => {
    reply(
      200,
      { "content-type": "text/plain", "content-encoding": "gzip" },
      gzipSync("a".repeat(100_000)),
    );
    expect(await guardedRequest("https://example.com/", { maxBytes: 256 })).toMatchObject({
      body: "a".repeat(256),
      downloadTruncated: true,
    });
    expect(opened[0].destroyed).toBe(true);
  });

  it("rejects compressed responses over the wire cap or with damaged frames", async () => {
    reply(200, { "content-type": "text/plain", "content-encoding": "gzip" }, gzipSync("abc"));
    await expect(guardedRequest("https://example.com/", { maxBytes: 10 })).rejects.toThrow(
      "Compressed download limit reached",
    );
    reply(200, { "content-type": "text/plain", "content-encoding": "gzip" }, Buffer.from("bad"));
    await expect(guardedRequest("https://example.com/", { maxBytes: 100 })).rejects.toThrow(
      "Invalid compressed response",
    );
    reply(
      200,
      { "content-type": "text/plain", "content-encoding": "gzip" },
      gzipSync("abc").subarray(0, -4),
    );
    await expect(guardedRequest("https://example.com/", { maxBytes: 100 })).rejects.toThrow(
      "Invalid compressed response",
    );
    expect(opened.every((stream) => stream.destroyed)).toBe(true);
  });

  it("rejects stacked encodings but accepts an explicit identity", async () => {
    for (const encoding of ["gzip, br", "", "gzip; q=1"]) {
      reply(200, { "content-type": "text/plain", "content-encoding": encoding }, "bad");
      await expect(guardedRequest("https://example.com/", { maxBytes: 100 })).rejects.toThrow(
        /encoding/i,
      );
    }
    reply(200, { "content-type": "text/plain", "content-encoding": " Identity " }, "ok");
    expect((await guardedRequest("https://example.com/", { maxBytes: 100 })).body).toBe("ok");
  });

  it("marks an exact decoded gzip limit as truncated", async () => {
    reply(200, { "content-type": "text/plain", "content-encoding": "gzip" }, gzipSync("hello"));
    expect(await guardedRequest("https://example.com/", { maxBytes: 50 })).toMatchObject({
      body: "hello",
      downloadTruncated: false,
    });
    reply(200, { "content-type": "text/plain", "content-encoding": "gzip" }, gzipSync("hello"));
    await expect(guardedRequest("https://example.com/", { maxBytes: 5 })).rejects.toThrow(
      "Compressed download limit reached",
    );
    const text = "a".repeat(100);
    reply(200, { "content-type": "text/plain", "content-encoding": "gzip" }, gzipSync(text));
    expect(await guardedRequest("https://example.com/", { maxBytes: 100 })).toMatchObject({
      body: text,
      downloadTruncated: true,
    });
  });

  it("stops a compressed body on cancellation and timeout", async () => {
    for (const cause of ["cancel", "timeout"]) {
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      replies.push({
        status: 200,
        headers: { "content-type": "text/plain", "content-encoding": "gzip" },
        hold: true,
      });
      const caller = new AbortController();
      const pending = guardedRequest("https://example.com/", {
        maxBytes: 100,
        signal: caller.signal,
      });
      await vi.waitFor(() => expect(opened).toHaveLength(cause === "cancel" ? 1 : 2));
      opened.at(-1)?.write(gzipSync("hello").subarray(0, 5));
      if (cause === "cancel") caller.abort();
      else deadline.abort();
      await expect(pending).rejects.toMatchObject({
        name: cause === "cancel" ? "AbortError" : "TimeoutError",
      });
      expect(opened.at(-1)?.destroyed).toBe(true);
    }
  });

  it("decodes declared charsets and refuses unsupported labels", async () => {
    reply(
      200,
      { "content-type": "text/plain; charset=iso-8859-1" },
      Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    );
    expect((await guardedRequest("https://example.com/", { maxBytes: 100 })).body).toBe("café");
    reply(200, { "content-type": "text/plain; charset=unsupported-charset" }, "text");
    await expect(guardedRequest("https://example.com/", { maxBytes: 100 })).rejects.toThrow(
      /charset/i,
    );
  });

  it("refuses missing MIME and oversized limits, but accepts JSON and a missing DNS family", async () => {
    await expect(
      guardedRequest("https://example.com/", { maxBytes: 5 * 1024 * 1024 + 1 }),
    ).rejects.toThrow(/limit/i);
    reply(200, {}, "untyped");
    await expect(guardedRequest("https://example.com/", { maxBytes: 100 })).rejects.toThrow(
      /content type/i,
    );
    vi.mocked(resolve6).mockRejectedValueOnce(
      Object.assign(new Error("no IPv6"), { code: "ENODATA" }),
    );
    reply(200, { "content-type": "application/json" }, '{"ok":true}');
    expect((await guardedRequest("https://example.com/", { maxBytes: 100 })).body).toBe(
      '{"ok":true}',
    );
  });

  it("times out during DNS and preserves caller cancellation during headers", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    vi.mocked(resolve4).mockImplementationOnce(() => new Promise(() => {}));
    const slowDns = guardedRequest("https://example.com/", { maxBytes: 100 });
    const timeout = expect(slowDns).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Request timed out",
    });
    await vi.waitFor(() => expect(resolve4).toHaveBeenCalled());
    deadline.abort();
    await timeout;
    expect(httpsRequest).not.toHaveBeenCalled();

    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    replies.push({ status: 200, holdHeaders: true });
    const caller = new AbortController();
    const slowHeaders = guardedRequest("https://example.com/", {
      maxBytes: 100,
      signal: caller.signal,
    });
    const cancellation = expect(slowHeaders).rejects.toMatchObject({
      name: "AbortError",
      message: "Request cancelled",
    });
    await vi.waitFor(() => expect(httpsRequest).toHaveBeenCalled());
    caller.abort();
    await cancellation;
  });

  it("stops a stalled body on cancellation and hides network error details", async () => {
    replies.push({ status: 200, headers: { "content-type": "text/plain" }, hold: true });
    const caller = new AbortController();
    const pending = guardedRequest("https://example.com/", {
      maxBytes: 100,
      signal: caller.signal,
    });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(opened[0].destroyed).toBe(true);
  });

  it("pins an IPv6-only DNS answer and refuses an inconsistent DNS failure", async () => {
    vi.mocked(resolve4).mockRejectedValueOnce(
      Object.assign(new Error("no A"), { code: "ENODATA" }),
    );
    reply(200, { "content-type": "text/plain" }, "IPv6");
    expect((await guardedRequest("https://example.com/", { maxBytes: 20 })).body).toBe("IPv6");
    const lookup = vi.mocked(httpsRequest).mock.calls[0][1].lookup;
    if (!lookup) throw new Error("Missing pinned lookup");
    await new Promise<void>((resolve, reject) =>
      lookup("example.com", { all: true }, (error, addresses) => {
        if (error) return reject(error);
        expect(addresses).toEqual([{ address: "2001:4860:4860::8888", family: 6 }]);
        resolve();
      }),
    );
    vi.mocked(resolve6).mockRejectedValueOnce(
      Object.assign(new Error("private DNS detail"), { code: "ENOTFOUND" }),
    );
    await expect(guardedRequest("https://example.com/", { maxBytes: 20 })).rejects.toThrow(
      "DNS lookup failed",
    );
  });

  it("permits ten redirects, refuses unsupported redirects and HTTP errors", async () => {
    for (let i = 0; i < 10; i++) reply(302, { location: "/next" });
    reply(200, { "content-type": "text/plain" }, "ok");
    expect((await guardedRequest("https://example.com/", { maxBytes: 20 })).body).toBe("ok");
    reply(302, { location: "file:///etc/passwd" });
    await expect(guardedRequest("https://example.com/", { maxBytes: 20 })).rejects.toThrow(
      /invalid|refused/i,
    );
    for (const status of [403, 429]) {
      reply(status, { "content-type": "text/plain" }, "secret response");
      await expect(guardedRequest("https://example.com/", { maxBytes: 20 })).rejects.toThrow(
        `HTTP ${status}`,
      );
    }
    expect(opened.every((stream) => stream.destroyed)).toBe(true);
  });

  it("applies the same deadline to a stalled body and never falls back to HTTP on TLS failure", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    replies.push({ status: 200, headers: { "content-type": "text/plain" }, hold: true });
    const stalled = guardedRequest("http://example.com/", { maxBytes: 20 });
    const rejection = expect(stalled).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    deadline.abort();
    await rejection;
    expect(opened[0].destroyed).toBe(true);
    expect(httpRequest).not.toHaveBeenCalled();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    vi.mocked(httpsRequest).mockImplementationOnce(() => {
      throw new Error("Invalid secret TLS detail");
    });
    await expect(guardedRequest("https://example.com/", { maxBytes: 20 })).rejects.toThrow(
      "Network request failed",
    );
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("checks DNS again after a redirect to another host", async () => {
    reply(302, { location: "https://second.example/" });
    vi.mocked(resolve4)
      .mockResolvedValueOnce(["8.8.8.8"])
      .mockResolvedValueOnce(["169.254.169.254"]);
    await expect(guardedRequest("https://example.com/", { maxBytes: 20 })).rejects.toThrow(
      /refused/i,
    );
    expect(httpsRequest).toHaveBeenCalledTimes(1);
    expect(opened[0].destroyed).toBe(true);
  });

  it("rejects non-HTTP URLs and credentials without echoing them", async () => {
    for (const url of [
      "file:///etc/passwd",
      "https://user:secret@example.com/",
      "https://@example.com/",
      "https:///missing-host",
    ]) {
      await expect(guardedRequest(url, { maxBytes: 1024 })).rejects.toThrow(/invalid|refused/i);
      await expect(guardedRequest(url, { maxBytes: 1024 })).rejects.not.toThrow(/secret|passwd/);
    }
  });
});
