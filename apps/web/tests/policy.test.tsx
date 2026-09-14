import {describe,expect,it} from 'bun:test';
import {actionAvailability,nodeConnectionStatus,statusLayers} from '../src/policy';

describe('console policies',()=>{
 it('names each endpoint health layer by the concrete subsystem it measures',()=>expect(statusLayers({node:'online',runtime:'ready',provider:'degraded',protocol:'disconnected',convergence:'conflicted'}).map(x=>x.label)).toEqual(['Agent node','Container','Driver probe','Protocol service','Desired state']));
 it('requires permission, capability, and no active conflict',()=>{
  expect(actionAvailability('start',{permissions:['endpoint:start'],capabilities:{operations:['start']},activeOperationId:null})).toEqual({visible:true,disabled:false});
  expect(actionAvailability('start',{permissions:[],capabilities:{operations:['start']},activeOperationId:null}).visible).toBe(false);
  expect(actionAvailability('start',{permissions:['endpoint:start'],capabilities:{operations:[]},activeOperationId:null}).visible).toBe(false);
  expect(actionAvailability('start',{permissions:['endpoint:start'],capabilities:{operations:['start']},activeOperationId:'op'}).disabled).toBe(true);
  expect(actionAvailability('delete',{permissions:['endpoint:delete'],capabilities:{operations:['delete']},activeOperationId:null})).toEqual({visible:true,disabled:false});
  expect(actionAvailability('delete',{permissions:[],capabilities:{operations:['delete']},activeOperationId:null}).visible).toBe(false);
 });
 it('allows force restart to interrupt active operations using restart permission',()=>{
  const context={permissions:['endpoint:restart'],capabilities:{operations:['force-restart','restart']},activeOperationId:'stuck-operation'};
  expect(actionAvailability('force-restart',context)).toEqual({visible:true,disabled:false});
  expect(actionAvailability('restart',context)).toEqual({visible:true,disabled:true});
  expect(actionAvailability('force-restart',{...context,activeOperationId:null})).toEqual({visible:true,disabled:false});
 });
 it('hides force restart without restart permission or server capability',()=>{
  const context={permissions:['endpoint:restart'],capabilities:{operations:['force-restart']},activeOperationId:'stuck-operation'};
  expect(actionAvailability('force-restart',{...context,permissions:[]})).toEqual({visible:false,disabled:true});
  expect(actionAvailability('force-restart',{...context,capabilities:{operations:['restart']}})).toEqual({visible:false,disabled:true});
 });
 it('blocks force restart during endpoint deletion',()=>{
  expect(actionAvailability('force-restart',{permissions:['endpoint:restart'],capabilities:{operations:['force-restart']},activeOperationId:'deleting-operation',activeOperation:{action:'delete'}})).toEqual({visible:true,disabled:true});
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
