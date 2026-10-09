import { describe, expect, it } from "vitest";
import { AcpSessionPool } from "./pool.js";

const fixture = [
  'process.stdin.setEncoding("utf8");',
  'let b=""; let prompts=0;',
  'process.stdin.on("data", x=>{b+=x;let i;while((i=b.indexOf("\\n"))>=0){',
  'const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);',
  'const send=x=>process.stdout.write(JSON.stringify(x)+"\\n");',
  'if(m.method==="initialize") send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});',
  'if(m.method==="session/new") send({jsonrpc:"2.0",id:m.id,result:{sessionId:"abc"}});',
  'if(m.method==="session/prompt"){ prompts++;',
  'send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"abc",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:String(prompts)}}}});',
  'send({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}});',
  '}',
  '}});',
].join("\n");

const agent = { command: process.execPath, args: ["-e", fixture], timeoutMs: 5000, startupTimeoutMs: 3000, inactivityTimeoutMs: 3000 };

describe("persistent ACP sessions", () => {
  it("reuses one ACP session for sequential prompts", async () => {
    const pool = new AcpSessionPool({ idleTimeoutMs: 5000 });
    try {
      expect(await pool.run("test", agent, process.cwd(), "first")).toBe("1");
      expect(await pool.run("test", agent, process.cwd(), "second")).toBe("2");
    } finally { pool.close(); }
  });
  it("does not reuse sessions across workspaces", async () => {
    const pool = new AcpSessionPool({ idleTimeoutMs: 5000 });
    try {
      expect(await pool.run("test", agent, process.cwd(), "first")).toBe("1");
      expect(await pool.run("test", agent, "/tmp", "second")).toBe("1");
    } finally { pool.close(); }
  });
  it("rejects concurrent prompts on one session", async () => {
    const pool = new AcpSessionPool({ idleTimeoutMs: 5000 });
    const slow = { command: process.execPath, args: ["-e", 'process.stdin.resume()'], startupTimeoutMs: 1000 };
    try {
      const abort = new AbortController();
      const first = pool.run("test", slow, process.cwd(), "first", abort.signal);
      await expect(pool.run("test", slow, process.cwd(), "second")).rejects.toThrow(/busy/);
      abort.abort();
      await expect(first).rejects.toThrow(/cancel/i);
    } finally { pool.close(); }
  });
  it("does not reuse a cancelled session", async () => {
    const pool = new AcpSessionPool({ idleTimeoutMs: 5000 });
    const abort = new AbortController();
    abort.abort();
    try {
      await expect(pool.run("test", agent, process.cwd(), "first", abort.signal)).rejects.toThrow(/cancel/i);
      expect(await pool.run("test", agent, process.cwd(), "second")).toBe("1");
    } finally { pool.close(); }
  });
});
