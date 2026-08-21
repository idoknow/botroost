import {describe,expect,it} from 'bun:test';
import {trafficDisplayStatus} from '../src/traffic-status';

const now=Date.parse('2026-08-21T12:00:30.000Z');

describe('trafficDisplayStatus',()=>{
  it('shows live only for a fresh successful sample',()=>{
    expect(trafficDisplayStatus({trafficStatus:'ok',freshness:{fresh:true,observationAt:'2026-08-21T12:00:25.000Z',nodeHeartbeatAt:'2026-08-21T12:00:29.000Z',checkedAt:'2026-08-21T12:00:29.000Z',staleAfterSeconds:15},requestFailed:false,now})).toBe('live');
  });

  it('fails closed for stale persisted observations',()=>{
    expect(trafficDisplayStatus({trafficStatus:'ok',freshness:{fresh:true,observationAt:'2026-08-21T12:00:00.000Z',nodeHeartbeatAt:'2026-08-21T12:00:29.000Z',checkedAt:'2026-08-21T12:00:01.000Z',staleAfterSeconds:15},requestFailed:false,now})).toBe('stale');
  });

  it('uses elapsed client time without assuming the browser clock matches the server',()=>{
    expect(trafficDisplayStatus({trafficStatus:'ok',freshness:{fresh:true,observationAt:'2026-08-21T11:59:55.000Z',nodeHeartbeatAt:'2026-08-21T11:59:59.000Z',checkedAt:'2026-08-21T12:00:00.000Z',staleAfterSeconds:15},requestFailed:false,receivedAt:Date.parse('2026-08-21T18:00:00.000Z'),now:Date.parse('2026-08-21T18:00:05.000Z')})).toBe('live');
  });

  it('fails closed immediately when polling is rejected',()=>{
    expect(trafficDisplayStatus({trafficStatus:'ok',freshness:{fresh:true,observationAt:'2026-08-21T12:00:29.000Z',nodeHeartbeatAt:'2026-08-21T12:00:29.000Z',checkedAt:'2026-08-21T12:00:29.000Z',staleAfterSeconds:15},requestFailed:true,now})).toBe('unavailable');
  });

  it('preserves explicit partial and unavailable sampler states',()=>{
    const freshness={fresh:true,observationAt:'2026-08-21T12:00:29.000Z',nodeHeartbeatAt:'2026-08-21T12:00:29.000Z',checkedAt:'2026-08-21T12:00:29.000Z',staleAfterSeconds:15};
    expect(trafficDisplayStatus({trafficStatus:'partial',freshness,requestFailed:false,now})).toBe('partial');
    expect(trafficDisplayStatus({trafficStatus:'unavailable',freshness,requestFailed:false,now})).toBe('unavailable');
  });
});