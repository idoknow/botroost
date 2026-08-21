export type TrafficFreshness={
  fresh:boolean;
  observationAt:string|null;
  nodeHeartbeatAt:string|null;
  checkedAt:string;
  staleAfterSeconds:number;
};

export type TrafficDisplayStatus='live'|'partial'|'stale'|'unavailable';

export function trafficDisplayStatus(input:{
  trafficStatus:'ok'|'partial'|'unavailable';
  freshness?:TrafficFreshness;
  requestFailed:boolean;
  receivedAt?:number;
  now?:number;
}):TrafficDisplayStatus{
  if(input.requestFailed||input.trafficStatus==='unavailable')return'unavailable';
  const freshness=input.freshness;
  if(!freshness?.fresh)return'stale';
  const observedAt=freshness.observationAt===null?Number.NaN:Date.parse(freshness.observationAt);
  const checkedAt=Date.parse(freshness.checkedAt),now=input.now??Date.now();
  const age=input.receivedAt===undefined?now-observedAt:Math.max(0,checkedAt-observedAt)+Math.max(0,now-input.receivedAt);
  if(!Number.isFinite(observedAt)||!Number.isFinite(checkedAt)||age>freshness.staleAfterSeconds*1000)return'stale';
  return input.trafficStatus==='partial'?'partial':'live';
}