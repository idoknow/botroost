export type ResourceUsage={source:'docker.stats';status:'ok'|'unavailable'|'stopped';observedAt:string|null;cpuPercent:number|null;memoryBytes:number|null;cpuLimitMillis:number|null;memoryLimitBytes:number|null};
export function resourceState(sample:ResourceUsage|undefined,node:string,failed:boolean,now:number):'live'|'stale'|'missing'|'stopped'{
 if(!sample)return 'missing';
 if(sample.status==='stopped')return 'stopped';
 const observed=sample.observedAt?Date.parse(sample.observedAt):NaN;
 if(sample.status!=='ok'||!Number.isFinite(observed)||sample.cpuPercent===null||sample.memoryBytes===null||!Number.isFinite(sample.cpuPercent)||!Number.isFinite(sample.memoryBytes)||sample.cpuPercent<0||sample.memoryBytes<0)return 'missing';
 return failed||node!=='online'||now-observed>15000||observed-now>5000?'stale':'live';
}
