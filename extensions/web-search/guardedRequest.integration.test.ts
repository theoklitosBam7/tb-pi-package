import { createServer } from "node:https";
import { request as httpsRequest } from "node:https";
import { TLSSocket } from "node:tls";
import { describe, expect, it } from "vitest";
import { pinnedTransportOptions } from "./guardedRequest.js";

// Test-only self-signed certificate for pinned.example.test. Trust is scoped to these requests.
const cert = `-----BEGIN CERTIFICATE-----
MIIDPTCCAiWgAwIBAgIUHOwWCGcVWKSijAmE+qhaMC5G8eowDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTcGlubmVkLmV4YW1wbGUudGVzdDAeFw0yNjA5MjYxOTUx
NDlaFw0zNjA5MjMxOTUxNDlaMB4xHDAaBgNVBAMME3Bpbm5lZC5leGFtcGxlLnRl
c3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDg8Z0FfUFlKQkfreve
kip/FaAAodOoLg2APwnyK0bCBcSgjWUSLK1RBds63QpbjndJ3QmGyWm0EJUqCL0m
0g1nte+Fv4CLTxTGvexL8HAYq/8FTOqvqJ16sqTlhqteb72x5yHRZrhSrpz2hV7f
E4JNxRoqmL6KE2GOBN+ej6sxZCE9Zhinl0QOlbQubWd5PloGo/Q4XADSXxXoMU7y
inES32keBnGIdSMvM6caxqMjG5M8YArFkEBeVoJZHyrZOVjvWUu9pFTDk2fXOyt9
WQr07k9dFUMDgKjXU+tv9hNUD+QPBNsCfiCnzh57q6RUqMXcLpvG57H9NDD6pk+4
LG6jAgMBAAGjczBxMB0GA1UdDgQWBBTxdxya5wX/8+lyWvj0+0UrJOXsUzAfBgNV
HSMEGDAWgBTxdxya5wX/8+lyWvj0+0UrJOXsUzAPBgNVHRMBAf8EBTADAQH/MB4G
A1UdEQQXMBWCE3Bpbm5lZC5leGFtcGxlLnRlc3QwDQYJKoZIhvcNAQELBQADggEB
AGW/T5ZnslpUkpcTmm1sWxMjiGrAY3hLOi3tf9nzqOFVsbhT1yryxA8iQKDowhni
nhHvpMncfhTmFvatDH8mdMuJbiI0rdJ3W7lrZmeSW5HX4GMH/o3U7KggH4/Ew5no
YCd2sIjMKSYI3uqOZYF3js0JKwWjl5KYLPmeTZERuLJiILjgL4gOyWopn/BF5m01
U5xqSozcDfxnqHS426UzZrKid83xmBKxAF88SXTe3EBaVlvQuJHXxkSlE7t8E7Qe
ziU2eTizW6/xZjbaizqLB94Tl2mcC86s/TPW6G1f2mHMAiJapoxLrIxSDbdwr/BZ
AIcEB/8KL1DoL1sNe3gofUk=
-----END CERTIFICATE-----`;
const key = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDg8Z0FfUFlKQkf
revekip/FaAAodOoLg2APwnyK0bCBcSgjWUSLK1RBds63QpbjndJ3QmGyWm0EJUq
CL0m0g1nte+Fv4CLTxTGvexL8HAYq/8FTOqvqJ16sqTlhqteb72x5yHRZrhSrpz2
hV7fE4JNxRoqmL6KE2GOBN+ej6sxZCE9Zhinl0QOlbQubWd5PloGo/Q4XADSXxXo
MU7yinES32keBnGIdSMvM6caxqMjG5M8YArFkEBeVoJZHyrZOVjvWUu9pFTDk2fX
Oyt9WQr07k9dFUMDgKjXU+tv9hNUD+QPBNsCfiCnzh57q6RUqMXcLpvG57H9NDD6
pk+4LG6jAgMBAAECggEAUKxWdDGH0o/1BbeKcDhbpVhMGe3vytE5ZlU1a/S5W7xV
2H7dULdVMUm4ZlP/8vYVMhhj4kM59ao81OZtcA7FX/yP+pfDsjKacOyMYm/IxBBr
VatQP89pKygGm4rAyw2oKrWKG1+Lm5ukD4WlkLueb+XQjJZbP4nT4us8h9FexEdI
ulcgIYKtxnaCNbxpV6RzNPF7KNqAb3IvCNGUzML9HUJoMLUU8H/sjYFjujpOi2rF
+rWyr5+/RCHSNZyE6AFyNCYIM6uYxN7moprgp1dsHxGbcGnTwVs7o2fMkFu+FJsW
vkMW0Q1zpzRrCkgqQmXp/PP7ylGagxoYiBnadyOYAQKBgQD1D8FhCPT/cP/glAli
perafYDBl8qd55oAgjV5Vw+dET/CmhILGd6apODp0aX6iNbm9/AOkhAlNhohkxqc
0qLDSIKtLkr321rPwmBfFVtvSaraEOfmlGDCBUx0el945aw4jPIypM/RKtmvtDu9
onAxf0KYDgtQUv4YHTC0d6QPwQKBgQDq+/qEdwtcCs4FT3hrE6e50DAXrWbwI+a7
4QKoJDIM/UWrL9AXQOB0hwjWFFiAzp8aWFnhp4lauQp33scZCuAwV0hIMQdSRYuY
PUS30YJc3Jssx60N5D5uann1kD98dApSLlEqJpDO09OlVtMvQD9qVUa2ii90b0Ir
UEazSlAXYwKBgQCkjBi3tBD1uAVH4X7Py0J/xMeAthBpqIpijwui1w930o4yd8tn
ws4SnmUa+xdsuxc5bP+2eOL4aXRwWNsEs/ZwE68S48OY26QFXqnhDnEfr6JV3AYq
cDTr8izdBRI4FldmfVVfJgUYmKIkdWursHeO9Lldagi0vZU50dfTRYZWwQKBgQCe
jT7PunNTu4afVqvts+lsGukYUMwwJEk/Y+ejBCkxUoN7qltCFWhdt+9iY4AECWaZ
JBwhgiXPrSM/FnZIk2oJtBr1ev9xp7M1GcIQNbE8by3U3TYLNYJahkWcR6ROmQ2N
verOAg+bPpqD6T29mCAx4zA/YqX6bke7agMKXo4D+QKBgChxoyYUMCuzCbv4mKaw
UG54JpugDcfz1tNS5I5mIH3c4kLrwhAzVzaNHJ9X/akV8uPil5hwRB0jP0eaUmFf
v2ZuZRv0wHwrKcedNmGccEqNjmphym1cCQIj0kSGrAGPO3fytoz87qcIuHMBhQ6Y
yxVCDqmsL13epGnXDqjLztNO
-----END PRIVATE KEY-----`;

describe("pinned HTTPS transport", () => {
  it("connects to the pinned socket while keeping Host, SNI and certificate hostname checks", async () => {
    const seen: { remoteAddress?: string; host?: string; servername?: string }[] = [];
    const server = createServer({ key, cert }, (request, response) => {
      const socket = request.socket;
      if (!(socket instanceof TLSSocket)) throw new Error("Expected TLS socket");
      seen.push({
        remoteAddress: socket.remoteAddress,
        host: request.headers.host,
        servername: typeof socket.servername === "string" ? socket.servername : undefined,
      });
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP server address");
      const port = address.port;
      const send = (host: string) =>
        new Promise<string>((resolve, reject) => {
          const url = new URL(`https://${host}:${port}/`);
          const request = httpsRequest(
            url,
            { ...pinnedTransportOptions(url, "127.0.0.1", new AbortController().signal), ca: cert },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk: string) => (body += chunk));
              response.on("end", () => resolve(body));
              response.on("error", reject);
            },
          );
          request.on("error", reject);
          request.end();
        });
      expect(await send("pinned.example.test")).toBe("ok");
      expect(seen).toEqual([
        {
          remoteAddress: "127.0.0.1",
          host: `pinned.example.test:${port}`,
          servername: "pinned.example.test",
        },
      ]);
      await expect(send("wrong.example.test")).rejects.toMatchObject({
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
