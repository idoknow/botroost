type Timer=ReturnType<typeof setTimeout>;
type Schedule=(callback:()=>void,delay:number)=>Timer;
type Cancel=(timer:Timer)=>void;

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
