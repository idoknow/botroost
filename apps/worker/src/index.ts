import { PostgresDatabase } from "@botroost/database";
import {ResendClient} from "./notifications.js";
export class DurableWorker{
  private nextObservationCleanupAt=0;
  private observationEndpointCursor:string|null=null;
  private async maintainObservations(){
    if(Date.now()<this.nextObservationCleanupAt)return;
    // Reserve cadence before awaiting: concurrent ticks must not overlap maintenance.
    this.nextObservationCleanupAt=Date.now()+60_000;
    try{
      const result=await this.db.pruneObservations({batchSize:200,...(this.observationEndpointCursor?{afterEndpointId:this.observationEndpointCursor}:{})});
      this.observationEndpointCursor=result.afterEndpointId;
      if(result.removed)console.info("observation retention",{removed:result.removed});
    }catch(error){console.warn("observation retention failed",error)}
    finally{this.nextObservationCleanupAt=Date.now()+60_000}
  }
  constructor(private db:PostgresDatabase,private emailConfig?:{apiKey:string;from:string},private resend=new ResendClient()){}
  async reconcileMissingOutbox(){return this.db.repairMissingOutbox()}
  async runOnce(){
    await this.reconcileMissingOutbox();
    await this.db.reconcileEndpointNotifications();
    const operationWorked=await this.db.processOne();
    const notificationWorked=this.emailConfig?await this.db.processConfiguredNotification(this.emailConfig,this.resend):false;
    await this.maintainObservations();
    return operationWorked||notificationWorked;
  }
}
const delay=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason)};const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve()},ms);signal.addEventListener("abort",abort,{once:true})});
export function emailConfigFromEnvironment(env:Record<string,string|undefined>){const apiKey=env.RESEND_API_KEY?.trim(),from=env.ALERT_EMAIL_FROM?.trim();if(!apiKey||!from)throw new Error("RESEND_API_KEY and ALERT_EMAIL_FROM must be configured together");return{apiKey,from}}
export async function runWorker(signal:AbortSignal=new AbortController().signal){const db=new PostgresDatabase(process.env.DATABASE_URL!);const emailConfig=emailConfigFromEnvironment(process.env);const worker=new DurableWorker(db,emailConfig);let failures=0;try{while(!signal.aborted){try{const worked=await worker.runOnce();failures=0;if(!worked)await delay(400+Math.random()*200,signal)}catch(error){if(signal.aborted)break;failures++;console.error("worker iteration failed",error);await delay(Math.min(30_000,500*2**Math.min(failures,6))*(0.75+Math.random()*0.5),signal)}}}finally{await db.close()}}
export {ResendClient,evaluateNapcatAlertTransition} from "./notifications.js";
