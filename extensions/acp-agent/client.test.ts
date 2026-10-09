import { describe, expect, it } from "vitest";
import { runAcpTask } from "./client.js";

const fixture = [
  'process.stdin.setEncoding("utf8");',
  'let buffer="";',
  'process.stdin.on("data", chunk => {',
  ' buffer += chunk;',
  ' let i; while((i=buffer.indexOf("\\n"))>=0) {',
  '  const raw=buffer.slice(0,i); buffer=buffer.slice(i+1);',
  '  const msg=JSON.parse(raw);',
  '  const send=x=>process.stdout.write(JSON.stringify(x)+"\\n");',
  '  if(msg.method==="initialize") send({jsonrpc:"2.0",id:msg.id,result:{protocolVersion:1,agentCapabilities:{}}});',
  '  if(msg.method==="session/new") send({jsonrpc:"2.0",id:msg.id,result:{sessionId:"test"}});',
  '  if(msg.method==="session/prompt") {',
  '   send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"test",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"done"}}}});',
  '   send({jsonrpc:"2.0",id:msg.id,result:{stopReason:"end_turn"}});',
  '  }',
  ' }',
  '});',
].join("\n");

describe("ACP task boundary", () => {
  it("sends a prompt and returns the agent text", async () => {
    const result = await runAcpTask({ command: process.execPath, args: ["-e", fixture] }, "/tmp", "review");
    expect(result).toBe("done");
  });

  it("rejects a failed agent executable", async () => {
    await expect(runAcpTask({ command: "/nonexistent/acp-agent", args: [] }, "/tmp", "review"))
      .rejects.toThrow();
  });

  it("rejects input over the task limit", async () => {
    await expect(runAcpTask({ command: process.execPath, args: ["-e", fixture] }, "/tmp", "x".repeat(100_001)))
      .rejects.toThrow(/too long/);
  });

  it("stops a cancelled request", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(runAcpTask({ command: process.execPath, args: ["-e", fixture] }, "/tmp", "review", abort.signal))
      .rejects.toThrow(/cancel/i);
  });
});
