import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoleTools } from "../pi-extension/subagents/role-tools.ts";

const tool = (name: string, body = 'return {content:[],details:{}}') => `({name:${JSON.stringify(name)},label:'Local',description:'Local tool',parameters:{type:'object',properties:{}},async execute(id,args,signal,update,ctx){${body}}})`;
function fixture(source: string, names = ["selected"]) {
  const dir = mkdtempSync(join(tmpdir(), "role-local-"));
  const entry = join(dir, "entry.mjs"); writeFileSync(entry, source);
  const hash = createHash("sha256").update(readFileSync(entry)).digest("hex");
  return { dir, entry, plan: {cwd:dir, builtinTools:["read"], extraTools:[{entry,hash,tools:names}]}, clean:()=>rmSync(dir,{recursive:true,force:true}) };
}
test("isolated loader registers only exact selected definitions, forces direct and preserves nested tool ctx", async () => {
  const f = fixture(`export default pi => {pi.registerTool({...${tool("selected", "return ctx.executeTool('read',args)")},exposure:'codemode'});pi.registerTool(${tool("unselected")});}`);
  try {
    const loaded = await loadRoleTools(f.plan, "full"); const registered: any[] = [];
    loaded.register({registerTool(t: any){registered.push(t);}});
    assert.deepEqual(registered.map(t=>t.name),["selected"]);
    assert.equal(registered[0].exposure,"direct");
    assert.deepEqual(loaded.sources, f.plan.extraTools);
    const ctx = {executeTool:async(name:string,args:unknown)=>({name,args})};
    assert.deepEqual(await registered[0].execute("id",{path:"x"},undefined,undefined,ctx),{name:"read",args:{path:"x"}});
    loaded.dispose(); assert.throws(()=>loaded.register({registerTool(){}}),/disposed|closed/i);
  } finally {f.clean();}
});
test("read-only never imports a local entry",async()=>{
  const f=fixture("throw new Error('MUST NOT IMPORT'); export default ()=>{};");
  try {const loaded=await loadRoleTools(f.plan,"read-only");assert.deepEqual(loaded.sources,[]);loaded.dispose();}finally{f.clean();}
});
for(const [kind,statement] of Object.entries({
  hook:"pi.on('session_start',()=>{});", command:"pi.registerCommand('bad',{handler:async()=>{}});",
  shortcut:"pi.registerShortcut('ctrl+x',{handler:async()=>{}});", flag:"pi.registerFlag('bad',{type:'boolean'});",
  renderer:"pi.registerMessageRenderer('bad',()=>{});", entryRenderer:"pi.registerEntryRenderer('bad',()=>{});",
  toolRenderer:"pi.registerToolRenderer(()=>{});", markdown:"pi.registerMarkdownTransformer(()=>{});",
  provider:"pi.registerProvider('bad',{api:'openai-completions',models:[]});", mcp:"pi.registerMcpServer('bad',{command:'never'});",
  eventbus:"pi.events.on('bad',()=>{});", emit:"pi.events.emit('bad',{});",
  runtime:"try {pi.setActiveTools(['bash']);} catch {}", exec:"try {pi.exec('never',[]);} catch {}",
  removedHook:"try {const off=pi.on('session_start',()=>{});off();} catch {}", virtual:"pi.registerVirtualModel({provider:'bad',id:'bad',route(){}});",
  assignment:"try {pi.on=()=>{};} catch {}", define:"try {Object.defineProperty(pi,'on',{value:()=>{}});} catch {}",
  deletion:"try {delete pi.registerTool;} catch {}", prototype:"try {Object.setPrototypeOf(pi,{});} catch {}",
})) test(`reject ${kind} behavior, including swallowed API errors`,async()=>{
  const f=fixture(`export default pi=>{${statement}pi.registerTool(${tool("selected")});}`);
  try {await assert.rejects(loadRoleTools(f.plan,"full"),/tool-only|unsupported|Failed to load/i);}finally{f.clean();}
});
for(const [label,source,names] of [
  ["duplicate",`pi.registerTool(${tool("selected")});pi.registerTool(${tool("selected")});`,["selected"]],
  ["missing",`pi.registerTool(${tool("other")});`,["selected"]],
  ["management",`pi.registerTool(${tool("subagent_control")});`,["subagent_control"]],
  ["question",`pi.registerTool(${tool("ask_question")});`,["ask_question"]],
  ["builtin",`pi.registerTool(${tool("read")});`,["read"]],
] as const) test(`reject ${label} tool`,async()=>{
  const f=fixture(`export default pi=>{${source}}`,[...names]);
  try{await assert.rejects(loadRoleTools(f.plan,"full"),/duplicate|missing|reserved|collision|forbidden/i);}finally{f.clean();}
});
test("hash drift and original implementation mutation are rejected",async()=>{
  const f=fixture(`export default pi=>{const t=${tool("selected","t.execute=async()=>({content:[],details:{}}); return {content:[],details:{}};")};pi.registerTool(t);}`);
  try {
    const loaded=await loadRoleTools(f.plan,"full");let definition:any;loaded.register({registerTool(t:any){definition=t;}});
    await definition.execute("id",{},undefined,undefined,{});
    assert.throws(()=>loaded.verify(),/implementation|definition|changed/i);loaded.dispose();
    writeFileSync(f.entry,"export default ()=>{};"); await assert.rejects(loadRoleTools(f.plan,"full"),/hash|changed/i);
  } finally {f.clean();}
});
test("factory result cannot hide a background resource and late registrars stay closed",async()=>{
  const bad=fixture(`export default pi=>{pi.registerTool(${tool("selected")});return {dispose(){}};}`);
  try{await assert.rejects(loadRoleTools(bad.plan),/void|background/i);}finally{bad.clean();}
  const late=fixture(`export default pi=>{pi.registerTool(${tool("selected","pi.registerTool({name:'late',parameters:{},execute(){}});return {content:[],details:{}};")});}`);
  try{const loaded=await loadRoleTools(late.plan);let definition:any;loaded.register({registerTool(t:any){definition=t;}});await assert.rejects(definition.execute('id',{},undefined,undefined,{}),/late registerTool/);loaded.dispose();}finally{late.clean();}
});
test("multiple selected tools import one canonical entry only once",async()=>{
  const f=fixture("",["selected","second"]);const marker=join(f.dir,"imports");
  const source=`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},'x');export default pi=>{pi.registerTool(${tool("selected")});pi.registerTool(${tool("second")});}`;
  writeFileSync(f.entry,source);f.plan.extraTools[0].hash=createHash("sha256").update(source).digest("hex");
  try{const loaded=await loadRoleTools(f.plan);assert.equal(readFileSync(marker,"utf8"),"x");const names:string[]=[];loaded.register({registerTool(t){names.push(t.name);}});assert.deepEqual(names,["selected","second"]);loaded.dispose();}finally{f.clean();}
});
