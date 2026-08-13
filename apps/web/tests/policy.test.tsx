import {describe,expect,it} from 'vitest';
import {actionAvailability,nodeConnectionStatus,statusLayers} from '../src/policy';

describe('console policies',()=>{
 it('preserves all five independent status layers',()=>expect(statusLayers({node:'online',runtime:'ready',provider:'degraded',protocol:'disconnected',convergence:'conflicted'}).map(x=>x.label)).toEqual(['Node','Runtime','Provider','Protocol','Convergence']));
 it('requires permission, capability, and no active conflict',()=>{
  expect(actionAvailability('start',{permissions:['endpoint:start'],capabilities:{operations:['start']},activeOperationId:null})).toEqual({visible:true,disabled:false});
  expect(actionAvailability('start',{permissions:[],capabilities:{operations:['start']},activeOperationId:null}).visible).toBe(false);
  expect(actionAvailability('start',{permissions:['endpoint:start'],capabilities:{operations:[]},activeOperationId:null}).visible).toBe(false);
  expect(actionAvailability('start',{permissions:['endpoint:start'],capabilities:{operations:['start']},activeOperationId:'op'}).disabled).toBe(true);
 });
 it('license-gates NapCat and enables fake provider',()=>{
  expect(actionAvailability('create',{permissions:['endpoint:create'],capabilities:{operations:['create'],providers:{napcat:{enabled:false,reason:'License required'}}},activeOperationId:null},'napcat')).toEqual({visible:true,disabled:true,reason:'License required'});
  expect(actionAvailability('create',{permissions:['endpoint:create'],capabilities:{operations:['create'],providers:{fake:{enabled:true}}},activeOperationId:null},'fake').disabled).toBe(false);
 });
 it('uses heartbeat freshness for node online state',()=>{
  expect(nodeConnectionStatus({lastHeartbeatAt:null})).toBe('offline');
  expect(nodeConnectionStatus({lastHeartbeatAt:new Date(Date.now()-10*60_000).toISOString()})).toBe('offline');
  expect(nodeConnectionStatus({lastHeartbeatAt:new Date().toISOString()})).toBe('online');
 });
});
