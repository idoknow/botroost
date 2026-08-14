export type NapcatAlertState="unknown"|"online"|"offline";
export type NapcatAlertEvent="offline"|"recovery";

export function evaluateNapcatAlertTransition(input:{previous:NapcatAlertState;incidentOpen:boolean;lastHeartbeatAt:Date|null;now:Date;graceSeconds:number}):{state:NapcatAlertState;incidentOpen:boolean;event:NapcatAlertEvent|null}{
  if(!input.lastHeartbeatAt)return{state:"unknown",incidentOpen:false,event:null};
  const online=input.now.getTime()-input.lastHeartbeatAt.getTime()<=input.graceSeconds*1000;
  const state:NapcatAlertState=online?"online":"offline";
  if(state==="offline"&&!input.incidentOpen)return{state,incidentOpen:true,event:"offline"};
  if(state==="online"&&input.incidentOpen)return{state,incidentOpen:false,event:"recovery"};
  return{state,incidentOpen:input.incidentOpen,event:null};
}

export interface ResendMessage{apiKey:string;from:string;to:string;subject:string;html:string;idempotencyKey?:string}
export class ResendClient{
  constructor(private options:{fetcher?:typeof fetch;timeoutMs?:number}={}){}
  async send(message:ResendMessage):Promise<{providerMessageId:string}>{
    const response=await (this.options.fetcher??globalThis.fetch)("https://api.resend.com/emails",{
      method:"POST",signal:AbortSignal.timeout(this.options.timeoutMs??10_000),headers:{Authorization:`Bearer ${message.apiKey}`,"Content-Type":"application/json","User-Agent":"Botroost/1.0 (+https://botroost.com)",...(message.idempotencyKey?{"Idempotency-Key":message.idempotencyKey}:{})},body:JSON.stringify({from:message.from,to:[message.to],subject:message.subject,html:message.html})
    });
    if(!response.ok)throw new Error(`Resend request failed (${response.status})`);
    const body=await response.json() as {id?:unknown};
    if(typeof body.id!=="string"||!body.id)throw new Error("Resend response missing message id");
    return{providerMessageId:body.id};
  }
}
