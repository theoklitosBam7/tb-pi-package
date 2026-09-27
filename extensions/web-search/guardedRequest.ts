import { resolve4, resolve6 } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";

const DEADLINE_MS = 15_000;
const MAX_REDIRECTS = 10;

class GuardedRequestError extends Error {}

type RequestOptions = { signal?: AbortSignal; maxBytes: number; allowedHosts?: readonly string[] };
type Result = {
  url: string;
  status: number;
  contentType: string;
  body: string;
  downloadTruncated: boolean;
};

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  // Exclude mapped and transition addresses, as well as special-purpose IPv6.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [firstText, secondText] = normalized.split(":");
  const first = Number.parseInt(firstText, 16);
  return (
    first >= 0x2000 &&
    first < 0x4000 &&
    !normalized.startsWith("2001:db8:") &&
    !(first === 0x2001 && Number.parseInt(secondText || "0", 16) < 0x200) &&
    first !== 0x2002 &&
    first !== 0x3fff
  );
}

async function approvedAddress(host: string): Promise<string> {
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new GuardedRequestError("Refused destination address");
    return host;
  }
  const records = await Promise.allSettled([resolve4(host), resolve6(host)]);
  const answers: string[] = [];
  for (const record of records) {
    if (record.status === "rejected") {
      // A hostname need not have both families. All other errors fail closed.
      if (record.reason?.code === "ENODATA") continue;
      throw new GuardedRequestError("DNS lookup failed");
    }
    answers.push(...record.value);
  }
  if (!answers.length) throw new GuardedRequestError("DNS lookup failed");
  if (answers.some((address) => !isPublicAddress(address)))
    throw new GuardedRequestError("Refused destination address");
  return answers[0];
}

function validateUrl(input: string, allowedHosts?: readonly string[]): URL {
  if (input.length > 8192 || !/^https?:\/\/[^/]/i.test(input))
    throw new GuardedRequestError("Invalid URL");
  if (input.match(/^https?:\/\/([^/?#]*)/i)?.[1].includes("@"))
    throw new GuardedRequestError("Refused URL");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new GuardedRequestError("Invalid URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new GuardedRequestError("Refused URL");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new GuardedRequestError("Refused destination port");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    allowedHosts &&
    !allowedHosts.some((allowed) => allowed.toLowerCase() === host.replace(/\.$/, "").toLowerCase())
  ) {
    throw new GuardedRequestError("Refused destination host");
  }
  // Never retry on HTTP if TLS fails. URL parsing normalizes alternate numeric IPs.
  if (url.protocol === "http:") url.protocol = "https:";
  return url;
}

function abortError(signal?: AbortSignal): Error {
  const error = new Error(signal?.aborted ? "Request cancelled" : "Request timed out");
  error.name = signal?.aborted ? "AbortError" : "TimeoutError";
  return error;
}

function acceptedContentType(header: string): boolean {
  const mime = header.split(";", 1)[0].trim().toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime === "application/xhtml+xml" ||
    mime === "application/json" ||
    mime.endsWith("+json")
  );
}

// Transport configuration only. Callers must approve the destination before using it.
export function pinnedTransportOptions(
  url: URL,
  address: string,
  signal: AbortSignal,
): HttpsRequestOptions {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return {
    agent: false,
    servername: host,
    signal,
    headers: {
      Host: url.host,
      "Accept-Encoding": "identity",
      Accept: "text/html,application/xhtml+xml,application/json,text/*",
      "User-Agent": "Mozilla/5.0 (compatible; PiWebSearch/1.0)",
    },
    // Node may ask for all addresses. Supply ONLY the validated address.
    lookup: (_hostname, _options, callback) => callback(null, [{ address, family: isIP(address) }]),
  };
}

async function requestOnce({
  url,
  address,
  maxBytes,
  signal,
}: {
  url: URL;
  address: string;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<{
  response: IncomingMessage;
  contentType?: string;
  body: string;
  downloadTruncated: boolean;
}> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(url, pinnedTransportOptions(url, address, signal), resolve);
    request.on("error", reject);
    request.end();
  });

  const status = response.statusCode ?? 0;
  if ([301, 302, 303, 307, 308].includes(status)) {
    response.destroy();
    return { response, body: "", downloadTruncated: false };
  }
  if (status < 200 || status >= 300) {
    response.destroy();
    throw new GuardedRequestError(`HTTP ${status}`);
  }
  const contentType = response.headers["content-type"];
  if (typeof contentType !== "string" || !acceptedContentType(contentType)) {
    response.destroy();
    throw new GuardedRequestError("Unsupported or missing content type");
  }
  const encoding = response.headers["content-encoding"];
  if (encoding && encoding !== "identity") {
    response.destroy();
    throw new GuardedRequestError("Unsupported content encoding");
  }
  let decoder: TextDecoder;
  try {
    const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] ?? "utf-8";
    decoder = new TextDecoder(charset);
  } catch {
    response.destroy();
    throw new GuardedRequestError("Unsupported charset");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let downloadTruncated = false;
  try {
    for await (const chunk of response) {
      const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - size;
      chunks.push(bytes.subarray(0, remaining));
      size += Math.min(bytes.length, remaining);
      if (size === maxBytes) {
        downloadTruncated = true; // A full cap cannot prove that no more bytes follow.
        response.destroy();
        break;
      }
    }
  } finally {
    if (!response.destroyed) response.destroy();
  }
  return {
    response,
    contentType,
    body: decoder.decode(Buffer.concat(chunks, size)),
    downloadTruncated,
  };
}

export async function guardedRequest(url: string, options: RequestOptions): Promise<Result> {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0 ||
    options.maxBytes > 5 * 1024 * 1024
  ) {
    throw new GuardedRequestError("Invalid download limit");
  }
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const failOnAbort = () => abortError(options.signal);
  let rejectAbort: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(failOnAbort());
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([
      aborted,
      (async () => {
        let destination = validateUrl(url, options.allowedHosts);
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          if (signal.aborted) throw failOnAbort();
          const host = destination.hostname.replace(/^\[|\]$/g, "");
          const address = await approvedAddress(host);
          if (signal.aborted) throw failOnAbort();
          const { response, contentType, body, downloadTruncated } = await requestOnce({
            url: destination,
            address,
            maxBytes: options.maxBytes,
            signal,
          });
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            if (hop === MAX_REDIRECTS) throw new GuardedRequestError("Too many redirects");
            const location = response.headers.location;
            if (typeof location !== "string" || location.length > 8192)
              throw new GuardedRequestError("Invalid redirect");
            let next: string;
            try {
              next = new URL(location, destination).toString();
            } catch {
              throw new GuardedRequestError("Invalid redirect");
            }
            destination = validateUrl(next, options.allowedHosts);
            continue;
          }
          return {
            url: destination.toString(),
            status,
            contentType: contentType ?? "",
            body,
            downloadTruncated,
          };
        }
        throw new GuardedRequestError("Too many redirects");
      })(),
    ]);
  } catch (error) {
    if (signal.aborted) throw failOnAbort();
    if (error instanceof GuardedRequestError) {
      throw error;
    }
    throw new Error("Network request failed");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
