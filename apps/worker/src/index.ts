import { PostgresDatabase } from "@botroost/database";
import {ResendClient} from "./notifications.js";
export class DurableWorker{
  constructor(private db:PostgresDatabase,private emailConfig?:{apiKey:string;from:string},private resend=new ResendClient()){}
  async reconcileMissingOutbox(){return this.db.repairMissingOutbox()}
  async runOnce(){
    await this.reconcileMissingOutbox();
    await this.db.reconcileEndpointNotifications();
    const operationWorked=await this.db.processOne();
    const notificationWorked=this.emailConfig?await this.db.processConfiguredNotification(this.emailConfig,this.resend):false;
    return operationWorked||notificationWorked;
  }
}
const delay=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason)};const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve()},ms);signal.addEventListener("abort",abort,{once:true})});
export async function runWorker(signal:AbortSignal=new AbortController().signal){const db=new PostgresDatabase(process.env.DATABASE_URL!);const apiKey=process.env.RESEND_API_KEY?.trim(),from=process.env.ALERT_EMAIL_FROM?.trim();if(Boolean(apiKey)!==Boolean(from))throw new Error("RESEND_API_KEY and ALERT_EMAIL_FROM must be configured together");const worker=new DurableWorker(db,apiKey&&from?{apiKey,from}:undefined);let failures=0;try{while(!signal.aborted){try{const worked=await worker.runOnce();failures=0;if(!worked)await delay(400+Math.random()*200,signal)}catch(error){if(signal.aborted)break;failures++;console.error("worker iteration failed",error);await delay(Math.min(30_000,500*2**Math.min(failures,6))*(0.75+Math.random()*0.5),signal)}}}finally{await db.close()}}
export {ResendClient,evaluateNapcatAlertTransition} from "./notifications.js";
