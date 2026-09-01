type Timer=ReturnType<typeof setTimeout>;
type Schedule=(callback:()=>void,delay:number)=>Timer;
type Cancel=(timer:Timer)=>void;

export function createRefreshGeneration(){
  let current=0;
  let disposed=false;
  return{
    begin(){return++current},
    complete(generation:number){return!disposed&&generation===current},
    dispose(){disposed=true},
  };
}

export function createRequestFlight(request:(signal:AbortSignal)=>Promise<void>,timeoutMs:number,schedule:Schedule=setTimeout,cancel:Cancel=clearTimeout){
  let disposed=false;
  let inFlight:Promise<void>|undefined;
  let controller:AbortController|undefined;
  let timeout:Timer|undefined;
  const run=()=>{
    if(disposed)return Promise.resolve();
    if(inFlight)return inFlight;
    controller=new AbortController();
    timeout=schedule(()=>controller?.abort(new DOMException('Request timed out','TimeoutError')),timeoutMs);
    let requestPromise:Promise<void>;
    try{requestPromise=request(controller.signal)}catch(error){requestPromise=Promise.reject(error)}
    const current=requestPromise.finally(()=>{
      if(timeout!==undefined)cancel(timeout);
      timeout=undefined;
      controller=undefined;
      if(inFlight===current)inFlight=undefined;
    });
    inFlight=current;
    return current;
  };
  const dispose=()=>{
    disposed=true;
    if(timeout!==undefined)cancel(timeout);
    timeout=undefined;
    controller?.abort(new DOMException('Request cancelled','AbortError'));
  };
  return{run,dispose};
}

export function startCompletionPoller(run:()=>Promise<void>,delay:()=>number|undefined,schedule:Schedule=setTimeout,cancel:Cancel=clearTimeout){
  let stopped=false;
  let timer:Timer|undefined;
  const tick=async()=>{
    try{await run()}catch{/* The caller owns request error state. */}
    if(stopped)return;
    const next=delay();
    if(next)timer=schedule(()=>void tick(),next);
  };
  void tick();
  return()=>{stopped=true;if(timer!==undefined)cancel(timer)};
}
