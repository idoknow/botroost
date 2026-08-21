import {describe,expect,it} from 'bun:test';
import {createRequestFlight,startCompletionPoller} from '../src/polling';

const flush=()=>new Promise(resolve=>setTimeout(resolve,0));

describe('createRequestFlight',()=>{
  it('shares one in-flight request between scheduled and manual refreshes',async()=>{
    let resolve!:()=>void;
    let calls=0;
    const flight=createRequestFlight(async()=>{calls++;if(calls===1)await new Promise<void>(done=>{resolve=done})},10_000);
    const scheduled=flight.run();
    const manual=flight.run();
    expect(calls).toBe(1);
    expect(manual).toBe(scheduled);
    resolve();
    await scheduled;
    await flight.run();
    expect(calls).toBe(2);
    flight.dispose();
  });

  it('aborts the active request on timeout and cleanup',async()=>{
    const scheduled:Array<()=>void>=[];
    const signals:AbortSignal[]=[];
    const flight=createRequestFlight(signal=>{signals.push(signal);return new Promise<void>(()=>{})},10_000,callback=>{scheduled.push(callback);return scheduled.length as unknown as ReturnType<typeof setTimeout>},()=>{});
    void flight.run();
    scheduled[0]!();
    expect(signals[0]!.aborted).toBe(true);
    flight.dispose();
    const second=createRequestFlight(signal=>{signals.push(signal);return new Promise<void>(()=>{})},10_000,callback=>{scheduled.push(callback);return scheduled.length as unknown as ReturnType<typeof setTimeout>},()=>{});
    void second.run();
    second.dispose();
    expect(signals[1]!.aborted).toBe(true);
  });
});

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
