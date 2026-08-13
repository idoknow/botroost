import { startAgentFromEnv } from "./index.js";

const agent = await startAgentFromEnv();
const controller=new AbortController();process.once("SIGTERM",()=>controller.abort());process.once("SIGINT",()=>controller.abort());let failures=0;
const wait=(ms:number)=>new Promise<void>(resolve=>{const timer=setTimeout(resolve,ms);controller.signal.addEventListener("abort",()=>{clearTimeout(timer);resolve()},{once:true})});
try{while(!controller.signal.aborted){try{const worked=await agent.pollOnce();failures=0;if(!worked)await wait(800+Math.random()*400)}catch(error){if(controller.signal.aborted)break;failures++;console.error("agent iteration failed",error);await wait(Math.min(30_000,500*2**Math.min(failures,6))*(0.75+Math.random()*0.5))}}}finally{await agent.close()}
