import { spawnSync } from "node:child_process";
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
  it("closes idle sessions and starts fresh on the next task", async () => {
    const pool = new AcpSessionPool({ idleTimeoutMs: 30 });
    try {
      expect(await pool.run("test", agent, process.cwd(), "first")).toBe("1");
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await pool.run("test", agent, process.cwd(), "second")).toBe("1");
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

describe("ACP transport regressions", () => {
  it("returns UTF-8 text split between stdout writes", async () => {
    const script = "let b=\"\";process.stdin.on(\"data\",c=>{b+=c;let i;while((i=b.indexOf(\"\\n\"))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const send=x=>process.stdout.write(JSON.stringify(x)+\"\\n\");if(m.method===\"initialize\")send({jsonrpc:\"2.0\",id:m.id,result:{protocolVersion:1}});if(m.method===\"session/new\")send({jsonrpc:\"2.0\",id:m.id,result:{sessionId:\"s\"}});if(m.method===\"session/prompt\"){const str=JSON.stringify({jsonrpc:\"2.0\",method:\"session/update\",params:{sessionId:\"s\",update:{sessionUpdate:\"agent_message_chunk\",content:{type:\"text\",text:\"α\"}}}})+\"\\n\";const bytes=Buffer.from(str);const at=bytes.indexOf(Buffer.from(\"α\"))+1;process.stdout.write(bytes.subarray(0,at));setTimeout(()=>{process.stdout.write(bytes.subarray(at));send({jsonrpc:\"2.0\",id:m.id,result:{stopReason:\"end_turn\"}})},20)}}});";
    const pool = new AcpSessionPool();
    try {
      expect(await pool.run("utf8", { command: process.execPath, args: ["-e", script] }, process.cwd(), "hello")).toBe("α");
    } finally { pool.close(); }
  });
  it("reclaims capacity when an idle agent exits", async () => {
    const exiting = fixture + "\nprocess.stdin.on('data',()=>setTimeout(()=>process.exit(0),40));";
    const pool = new AcpSessionPool({ idleTimeoutMs: 5000 });
    try {
      expect(await pool.run("A", { command: process.execPath, args: ["-e", exiting] }, process.cwd(), "a")).toBe("1");
      expect(await pool.run("B", agent, process.cwd(), "b")).toBe("1");
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(await pool.run("C", agent, process.cwd(), "c")).toBe("1");
    } finally { pool.close(); }
  });
  it("evicts an idle session when a third agent needs capacity", async () => {
    const pool = new AcpSessionPool({ idleTimeoutMs: 5000 });
    try {
      expect(await pool.run("A", agent, process.cwd(), "first")).toBe("1");
      expect(await pool.run("B", agent, process.cwd(), "second")).toBe("1");
      expect(await pool.run("C", agent, process.cwd(), "third")).toBe("1");
      expect(await pool.run("A", agent, process.cwd(), "fourth")).toBe("1");
    } finally { pool.close(); }
  });
  it("applies timeoutMs to each prompt, not process lifetime", async () => {
    const pool = new AcpSessionPool({ idleTimeoutMs: 5000 });
    const short = { ...agent, timeoutMs: 800 };
    try {
      expect(await pool.run("test", short, process.cwd(), "first")).toBe("1");
      await new Promise(resolve => setTimeout(resolve, 900));
      expect(await pool.run("test", short, process.cwd(), "second")).toBe("2");
    } finally { pool.close(); }
  });
});

describe("ACP host process safety", () => {
  it("reports EPIPE without terminating the Pi host", () => {
    const host = [
      'const ts=require("typescript");',
      'const fs=require("node:fs");',
      'const Module=require("node:module");',
      'const file=process.argv[1];',
      'const js=ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;',
      'const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(process.cwd());mod._compile(js,file);',
      'const agentCode=' + JSON.stringify([
        'process.stdin.setEncoding("utf8");let b="";',
        'process.stdin.on("data",x=>{b+=x;let i;while((i=b.indexOf("\\n"))>=0){',
        'const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);',
        'const send=o=>process.stdout.write(JSON.stringify(o)+"\\n");',
        'if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1}});',
        'if(m.method==="session/new")send({jsonrpc:"2.0",id:m.id,result:{sessionId:"s"}});',
        'if(m.method==="session/prompt"){send({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}});process.stdin.destroy();setInterval(()=>{},1000);}',
        '}});',
      ].join("")) + ';',
      '(async()=>{const pool=new mod.exports.AcpSessionPool();try {',
      'const a={command:process.execPath,args:["-e",agentCode],timeoutMs:1500,startupTimeoutMs:1000,inactivityTimeoutMs:1000};',
      'await pool.run("agent",a,process.cwd(),"first");',
      'try {await pool.run("agent",a,process.cwd(),"second");process.exitCode=2;}',
      'catch(e){if(!/transport|process|closed/i.test(String(e)))process.exitCode=3;}',
      '}finally{pool.close();}})().catch(e=>{console.error(e);process.exitCode=4});',
    ].join("\n");
    const file = new URL("./pool.ts", import.meta.url);
    const result = spawnSync(process.execPath, ["-e", host, file.pathname], {
      cwd: process.cwd(), encoding: "utf8", timeout: 5000,
    });
    expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
      status: 0, signal: null, stderr: "",
    });
  });
});
