import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from './api';
import {createRequestFlight,startCompletionPoller} from './polling';

const POLL_TIMEOUT_MS=10_000;

type RequestFlight=ReturnType<typeof createRequestFlight>;

export function useApi<T>(path:string,interval?:number|((data:T|undefined)=>number|undefined),enabled=true){
  const[data,setData]=useState<T>();
  const[error,setError]=useState<Error>();
  const[loading,setLoading]=useState(enabled);
  const[refreshing,setRefreshing]=useState(false);
  const dataRef=useRef<T|undefined>(undefined);
  const intervalRef=useRef(interval);
  const flightRef=useRef<RequestFlight|undefined>(undefined);
  intervalRef.current=interval;

  const refresh=useCallback(async()=>{
    const flight=flightRef.current;
    if(!flight)return;
    setRefreshing(true);
    try{await flight.run()}finally{setRefreshing(false)}
  },[]);

  useEffect(()=>{
    if(!enabled){setLoading(false);return}
    let disposed=false;
    const flight=createRequestFlight(async signal=>{
      try{
        const next=await api.get<T>(path,{signal});
        if(!disposed){dataRef.current=next;setData(next);setError(undefined)}
      }catch(cause){
        if(!disposed)setError(cause as Error);
      }finally{
        if(!disposed)setLoading(false);
      }
    },POLL_TIMEOUT_MS);
    flightRef.current=flight;
    const stop=startCompletionPoller(flight.run,()=>{
      const current=intervalRef.current;
      return typeof current==='function'?current(dataRef.current):current;
    });
    return()=>{
      disposed=true;
      stop();
      flight.dispose();
      if(flightRef.current===flight)flightRef.current=undefined;
    };
  },[path,enabled]);

  return{data,error,loading,refresh,refreshing,setData};
}

export function usePath(){
  const[path,setPath]=useState(location.pathname+location.search);
  useEffect(()=>{const fn=()=>setPath(location.pathname+location.search);addEventListener('popstate',fn);return()=>removeEventListener('popstate',fn)},[]);
  return path;
}
