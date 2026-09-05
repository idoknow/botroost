import {expect,test} from 'bun:test';
import {resourceState} from '../src/system-status-policy';
const sample={source:'docker.stats' as const,status:'ok' as const,observedAt:'2026-09-05T00:00:00.000Z',cpuPercent:0,memoryBytes:0,cpuLimitMillis:1000,memoryLimitBytes:1073741824};
const now=Date.parse(sample.observedAt);
test('resources preserve real zero and expire old, offline or failed observations',()=>{
 expect(resourceState(sample,'online',false,now)).toBe('live');
 expect(resourceState(sample,'online',false,now+15001)).toBe('stale');
 expect(resourceState(sample,'offline',false,now)).toBe('stale');
 expect(resourceState(sample,'online',true,now)).toBe('stale');
 expect(resourceState(undefined,'online',false,now)).toBe('missing');
 expect(resourceState({...sample,status:'stopped'},'online',false,now)).toBe('stopped');
 expect(resourceState({...sample,cpuPercent:null},'online',false,now)).toBe('missing');
 expect(resourceState({...sample,observedAt:'bad'},'online',false,now)).toBe('missing');
 expect(resourceState({...sample,observedAt:new Date(now+10000).toISOString()},'online',false,now)).toBe('stale');
});
