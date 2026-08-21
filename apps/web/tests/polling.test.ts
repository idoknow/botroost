import {describe,expect,it} from 'bun:test';
import {startCompletionPoller} from '../src/polling';

const flush=()=>new Promise(resolve=>setTimeout(resolve,0));

describe('startCompletionPoller',()=>{
  it('does not schedule another poll while the current request is unresolved',async()=>{
    let resolve!:()=>void;
    let calls=0;
    const scheduled:Array<()=>void>=[];
    const stop=startCompletionPoller(()=>{calls++;return new Promise<void>(done=>{resolve=done})},()=>3_000,(callback)=>{scheduled.push(callback);return scheduled.length as unknown as ReturnType<typeof setTimeout>},()=>{});
    expect(calls).toBe(1);
    expect(scheduled).toHaveLength(0);
    await flush();
    expect(scheduled).toHaveLength(0);
    resolve();
    await flush();
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect(calls).toBe(2);
    expect(scheduled).toHaveLength(1);
    stop();
  });

  it('stops scheduling after cleanup even when a request finishes late',async()=>{
    let resolve!:()=>void;
    const scheduled:Array<()=>void>=[];
    const stop=startCompletionPoller(()=>new Promise<void>(done=>{resolve=done}),()=>3_000,(callback)=>{scheduled.push(callback);return scheduled.length as unknown as ReturnType<typeof setTimeout>},()=>{});
    stop();
    resolve();
    await flush();
    expect(scheduled).toHaveLength(0);
  });
});
