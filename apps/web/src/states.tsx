import {AlertTriangle,Box,LoaderCircle} from 'lucide-react';import {Button} from './ui';
export const Loading=({label='Loading',fullPage=false}:{label?:string;fullPage?:boolean})=><div className={`state ${fullPage?'full':''}`}><LoaderCircle className="spin" aria-label="Loading"/><span>{label}</span></div>;
export const Failure=({error}:{error:unknown})=><div className="alert error"><AlertTriangle/> <div><strong>Unable to load</strong><p>{error instanceof Error?error.message:'Request failed'}</p></div></div>;
export const Empty=({name}:{name:string})=><div className="state empty"><Box/><h2>No {name.toLowerCase()} found</h2><p>There is nothing to display yet.</p></div>;
export const NotFound=()=> <div className="state full"><h1>Page not found</h1><p>The requested console route does not exist or is not available to your role.</p><Button onClick={()=>location.assign('/')}>Return to overview</Button></div>;
