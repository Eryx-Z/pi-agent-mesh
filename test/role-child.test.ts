import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import roleChild, { validateRoleRunInput, assertRoleHostVersion } from "../pi-extension/subagents/role-child.ts";
import { rolePlanDigest, ROLE_CHILD_EXTENSION, type RolePlan } from "../pi-extension/subagents/role-loadout.ts";
import { readInfo } from "./fixtures/loadout.ts";

test("role execution version guard rejects legacy hosts without changing non-role loading", () => {
  for (const version of ["0.99.0", "1.0.0", "1.0.1", "2.0.0", "1.0.2-beta", "unknown"]) assert.throws(() => assertRoleHostVersion(version), /requires Pi 1.0.2/);
  for (const version of ["1.0.2", "1.0.3", "1.2.0"]) assert.doesNotThrow(() => assertRoleHostVersion(version));
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"role-local-child-")); const manifest=join(dir,"role.yaml");writeFileSync(manifest,"saved manifest");
  const plan:RolePlan={version:1,schemaVersion:1,roleId:"worker",manifestPath:manifest,manifestHash:hash("saved manifest"),systemPrompt:"Saved body",systemPromptHash:hash("Saved body"),promptVersion:1,skills:[],builtinTools:["read"],extraTools:[],mcp:[],model:"fake/test",thinking:"off",context:"none",access:"full",cwd:dir,agentDir:dir};
  const run = {version:1 as const,binding:{taskId:"task",run:1,attemptId:"attempt",nonce:"nonce",planHash:rolePlanDigest(plan)},access:"full" as const,status:"planned" as const};
  const resultPath=join(dir,"preflight.json");
  return {dir,plan,run,resultPath,clean:()=>rmSync(dir,{recursive:true,force:true})};
}
async function boot(f:ReturnType<typeof fixture>, access:"full"|"read-only"="full") {
  const handlers:Record<string,any>={},commands:Record<string,any>={};
  const definitions=new Map<string,any>(); const inventory:any[]=[readInfo(f.dir),{...readInfo(f.dir),name:"bash",sourceInfo:{...readInfo(f.dir).sourceInfo,path:"<builtin:bash>"}}];
  let active:string[]=["read","bash"];
  const pi:any={on:(name:string,h:any)=>handlers[name]=h,registerCommand:(name:string,c:any)=>commands[name]=c,
    registerTool(t:any){definitions.set(t.name,t);const i=inventory.findIndex(x=>x.name===t.name);const info={...t,exposure:t.exposure??"direct",sourceInfo:{source:"local",path:ROLE_CHILD_EXTENSION,scope:"temporary",origin:"top-level"}};if(i<0)inventory.push(info);else inventory[i]=info;active.push(t.name);},
    getAllTools:()=>inventory,getActiveTools:()=>active,setActiveTools:(names:string[])=>{active=[...names];},getThinkingLevel:()=>"off"};
  const ctx:any={model:{provider:"fake",id:"test"},getSystemPromptOptions:()=>({skills:[]}),mode:"rpc",ui:{input:async()=>"Answer"}};
  const previous=process.env.PI_RPC_SUBAGENT_ROLE_RUN;
  // Production stores private JSON in a file rather than putting large plans in env.
  const path=join(f.dir,"run.json");writeFileSync(path,JSON.stringify({plan:f.plan,run:{...f.run,access},resultPath:f.resultPath}),{mode:0o600});process.env.PI_RPC_SUBAGENT_ROLE_RUN=path;
  try{await roleChild(pi);}finally{if(previous===undefined)delete process.env.PI_RPC_SUBAGENT_ROLE_RUN;else process.env.PI_RPC_SUBAGENT_ROLE_RUN=previous;}
  await handlers.session_start({},ctx);
  return {handlers,commands,definitions,inventory,ctx,active:()=>active,preflight:()=>commands["rpc-subagent-preflight"].handler("",ctx),result:()=>JSON.parse(readFileSync(f.resultPath,"utf8"))};
}
test("role bridge freezes tools only after private atomic bound preflight, records actual bridge source",async()=>{
  const f=fixture();try{
    const b=await boot(f);assert.deepEqual(b.active(),[]);assert.deepEqual(b.handlers.input({text:"early"}),{action:"handled"});
    assert.equal(b.handlers.tool_call({toolName:"read"},b.ctx).block,true);
    await b.preflight();const result=b.result();assert.deepEqual(result.binding,f.run.binding);assert.equal(result.snapshot.preflightComplete,true);
    assert.deepEqual(result.snapshot.tools.map((t:any)=>t.name),["read"]);assert.equal(result.snapshot.tools[0].semanticKind,"builtin");
    assert.equal(result.snapshot.reservedBridge.sourceInfo.path,ROLE_CHILD_EXTENSION);assert.equal(result.snapshot.reservedBridge.exposure,"model-only");
    assert.equal(statSync(f.resultPath).mode&0o777,0o600);assert.deepEqual(b.active(),["read","ask_question"]);
    assert.equal(b.handlers.input({text:"ready"}),undefined);assert.equal(b.handlers.tool_call({toolName:"read"},b.ctx),undefined);
    assert.equal(b.handlers.tool_call({toolName:"bash",parentToolCallId:"parent"},b.ctx).block,true);
    const q=b.definitions.get("ask_question");assert.equal(q.executionMode,"sequential");assert.equal((await q.execute("id",{question:"Which?"},undefined,undefined,b.ctx)).content[0].text,"Answer");
    b.inventory[0].description="Changed schema/description";assert.equal(b.handlers.tool_call({toolName:"read"},b.ctx).block,true);assert.deepEqual(b.active(),[]);
  }finally{f.clean();}
});
test("preflight skill/model failures write bound error without enabling tools",async()=>{
  const f=fixture();try{const b=await boot(f);b.ctx.model.id="other";await b.preflight();assert.deepEqual(b.result().binding,f.run.binding);assert.match(b.result().error,/model|selected/i);assert.deepEqual(b.active(),[]);}finally{f.clean();}
});
test("read-only skips both declared local tools and MCP before loading either",async()=>{
  const f=fixture();try{
    const entry=join(f.dir,"must-not-run.mjs");const source="throw new Error('LOCAL WAS IMPORTED'); export default ()=>{};";writeFileSync(entry,source);
    f.plan.extraTools=[{entry,hash:hash(source),tools:["selected"]}];f.plan.mcp=[{server:"test",config:{command:"never"},tools:["remote"]}];f.run.binding.planHash=rolePlanDigest(f.plan);
    const ro=await boot(f,"read-only");await ro.preflight();assert.ok(ro.result().snapshot);assert.deepEqual(ro.active(),["read","ask_question"]);
  }finally{f.clean();}
});
test("local tools retain original entry/hash plus actual wrapper source and nested access guards",async()=>{
  const f=fixture();try{
    const entry=join(f.dir,"local.mjs");const source=`export default pi=>{
      pi.registerTool({name:'selected',label:'Selected',description:'Selected local',exposure:'deferred',parameters:{type:'object',properties:{name:{type:'string'}},required:['name']},async execute(id,args,signal,update,ctx){return ctx.executeTool(args.name,{});}});
      pi.registerTool({name:'unselected',label:'Unselected',description:'Must not register',parameters:{type:'object',properties:{}},async execute(){throw new Error('Must not execute');}});
    };`;writeFileSync(entry,source);f.plan.extraTools=[{entry,hash:hash(source),tools:["selected"]}];f.run.binding.planHash=rolePlanDigest(f.plan);
    const b=await boot(f);await b.preflight();assert.ok(b.result().snapshot,b.result().error);
    assert.equal(b.definitions.has("unselected"),false);
    const local=b.result().snapshot.tools.find((t:any)=>t.name==="selected");assert.equal(local.semanticKind,"local-tool");assert.equal(local.entry,entry);assert.equal(local.hash,hash(source));assert.equal(local.sourceInfo.path,ROLE_CHILD_EXTENSION);assert.equal(local.exposure,"direct");
    const nestedCtx={...b.ctx,async executeTool(name:string){const guard=b.handlers.tool_call({toolName:name,parentToolCallId:"selected/1"},nestedCtx);if(guard?.block)throw new Error(guard.reason);return {content:[],details:{name}};}};
    const selected=b.definitions.get("selected");assert.deepEqual((await selected.execute("id",{name:"read"},undefined,undefined,nestedCtx)).details,{name:"read"});
    for(const name of ["bash","unselected","ask_question"])await assert.rejects(selected.execute("id",{name},undefined,undefined,nestedCtx),/outside verified/);
    writeFileSync(entry,source+"\n// drift");assert.equal(b.handlers.tool_call({toolName:"read"},b.ctx).block,true);assert.deepEqual(b.active(),[]);
  }finally{f.clean();}
});
test("preflight checks actual skill inventory and rejects an unlisted extension tool",async()=>{
  const f=fixture();try{
    const path=join(f.dir,"SKILL.md");const body="---\nname: listed\ndescription: Listed\n---\nBody";writeFileSync(path,body);
    const skill={name:"listed",description:"Listed",filePath:path,loadPath:path,baseDir:f.dir,disableModelInvocation:false};f.plan.skills=[{...skill,hash:hash(body)}];f.run.binding.planHash=rolePlanDigest(f.plan);
    const b=await boot(f);await b.preflight();assert.match(b.result().error,/skill inventory|metadata mismatch/);
    b.ctx.getSystemPromptOptions=()=>({skills:[{...skill,sourceInfo:{source:"local",path,scope:"temporary",origin:"top-level"}}]});await b.preflight();assert.ok(b.result().snapshot,b.result().error);
    b.inventory.push({...readInfo(f.dir),name:"injected",sourceInfo:{source:"local",path:ROLE_CHILD_EXTENSION,scope:"temporary",origin:"top-level"}});
    assert.equal(b.handlers.tool_call({toolName:"read"},b.ctx).block,true);
  }finally{f.clean();}
});
test("real Pi role bridge loads selected tools, denies direct/nested unselected tools, and makes no preflight model request",{timeout:30000},async()=>{
  const f=fixture();let rpc:RpcProcess|undefined;
  try{
    const entry=join(f.dir,"entry.ts");const source=`export default function(pi){
      pi.registerTool({name:'selected',label:'Selected',description:'Nested probe',parameters:{type:'object',properties:{}},async execute(id,args,signal,update,ctx){
        const results={};for(const name of ['read','write','unselected','ask_question']){
          results[name]=await ctx.executeTool(name,name==='read'?{path:'input.txt'}:name==='write'?{path:'unauthorized',content:'BAD'}:name==='ask_question'?{question:'NEVER ASK'}:{});
        }return {content:[{type:'text',text:JSON.stringify(results)}],details:results};
      }});
      pi.registerTool({name:'unselected',label:'Unselected',description:'Never register',exposure:'codemode',parameters:{type:'object',properties:{}},async execute(){throw new Error('UNSELECTED EXECUTED');}});
    }`;writeFileSync(entry,source);writeFileSync(join(f.dir,"input.txt"),"ROLE_LOCAL_READ_OK");
    const provider=fileURLToPath(new URL('./fixtures/role-local-provider.ts',import.meta.url));f.plan.providerExtensions=[provider];f.plan.model="role-local/test";f.plan.extraTools=[{entry,hash:hash(source),tools:["selected"]}];f.run.binding.planHash=rolePlanDigest(f.plan);
    const runPath=join(f.dir,"run.json");writeFileSync(runPath,JSON.stringify({plan:f.plan,run:f.run,resultPath:f.resultPath}),{mode:0o600});
    const env:NodeJS.ProcessEnv={...process.env,PI_CODING_AGENT_DIR:join(f.dir,"agent"),PI_OFFLINE:"1",PI_SKIP_VERSION_CHECK:"1",PI_TELEMETRY:"0"};
    for(const key of Object.keys(env))if(key.startsWith("PI_RPC_SUBAGENT_")||key.startsWith("PI_SUBAGENT_"))delete env[key];env.PI_RPC_SUBAGENT_ROLE_RUN=runPath;
    const pkg=getPackageDir();const cli=join(pkg,JSON.parse(readFileSync(join(pkg,"package.json"),"utf8")).bin.pi);
    rpc=new RpcProcess({command:process.execPath,cwd:f.dir,env,args:[cli,"--mode","rpc","--no-session","--no-extensions","--no-skills","--no-context-files","--no-prompt-templates","--no-approve","--model",f.plan.model,"--thinking","off","-e",ROLE_CHILD_EXTENSION,"-e",provider]});
    await rpc.request("get_state");await rpc.request("prompt",{message:"MUST_NOT_CALL_MODEL"});assert.equal(existsSync(join(f.dir,"requests.jsonl")),false);
    await rpc.request("prompt",{message:"/rpc-subagent-preflight"});const result=JSON.parse(readFileSync(f.resultPath,"utf8"));assert.ok(result.snapshot,result.error);assert.deepEqual(result.binding,f.run.binding);
    assert.equal(existsSync(join(f.dir,"requests.jsonl")),false);const local=result.snapshot.tools.find((t:any)=>t.name==='selected');assert.equal(local.sourceInfo.path,ROLE_CHILD_EXTENSION);assert.equal(local.entry,entry);
    const settled=()=>new Promise<void>(resolve=>{const listener=(event:any)=>{if(event.type==='agent_settled'){rpc!.off('event',listener);resolve();}};rpc!.on('event',listener);});
    let done=settled();await rpc.request('prompt',{message:'CALL selected'});await done;
    let messages=(await rpc.request('get_messages')).messages;const toolResult=messages.find((m:any)=>m.role==='toolResult'&&m.toolName==='selected');assert.ok(toolResult,JSON.stringify(messages));assert.equal(toolResult.isError,false,JSON.stringify(toolResult));
    const nested=JSON.parse(toolResult.content[0].text);assert.equal(nested.read.isError,false);assert.match(JSON.stringify(nested.read),/ROLE_LOCAL_READ_OK/);for(const name of ['write','unselected','ask_question'])assert.equal(nested[name].isError,true,name);
    const declared=JSON.parse(readFileSync(join(f.dir,'requests.jsonl'),'utf8').split('\n')[0]).tools;assert.deepEqual(declared.sort(),['ask_question','read','selected']);
    done=settled();await rpc.request('prompt',{message:'CALL unselected'});await done;messages=(await rpc.request('get_messages')).messages;assert.ok(messages.some((m:any)=>m.role==='toolResult'&&m.toolName==='unselected'&&m.isError));assert.equal(existsSync(join(f.dir,'unauthorized')),false);
  }finally{await rpc?.stop();f.clean();}
});
test("role run rejects stale binding, invalid access/run/status before loading resources",()=>{
  const f=fixture();try{
    const input={plan:f.plan,run:f.run,resultPath:f.resultPath};assert.equal(validateRoleRunInput(input).run.binding.nonce,"nonce");
    for(const run of [{...f.run,access:"bad"},{...f.run,status:"bad"},{...f.run,binding:{...f.run.binding,run:0}},{...f.run,binding:{...f.run.binding,planHash:"stale"}},{...f.run,binding:{...f.run.binding,nonce:""}}])assert.throws(()=>validateRoleRunInput({...input,run}),/binding|access|run|status|digest/i);
  }finally{f.clean();}
});
