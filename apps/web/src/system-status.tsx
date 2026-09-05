import {useEffect,useState,type ReactNode} from 'react';
import {RefreshCw} from 'lucide-react';
import {api} from './api';
import {useApi} from './hooks';
import {useI18n} from './i18n';
import {nodeConnectionStatus} from './policy';
import {resourceState} from './system-status-policy';
import {Empty,Failure,Loading} from './states';
import type {Endpoint,Node,Page,Provider,Session} from './types';
import {Badge,Button,Link,Modal,PageHeading,Stack,Table,navigate} from './ui';
import {Tabs,TabsContent,TabsList,TabsTrigger} from './components/tabs';

type Query<T>=ReturnType<typeof useApi<T>>;
function Collection<T>({q,empty,children}:{q:Query<Page<T>>;empty:string;children:(items:T[])=>ReactNode}){
 return <>{q.error?<Failure error={q.error}/>:null}{q.data?(q.data.items.length?children(q.data.items):<Empty name={empty}/>):q.loading?<Loading/>:null}</>;
}
const bytes=(value:number|null|undefined)=>value===null||value===undefined?'—':value>=1073741824?`${(value/1073741824).toFixed(2)} GiB`:`${(value/1048576).toFixed(1)} MiB`;
export function SystemStatus({session,path,endpoints}:{session:Session;path:string;endpoints:Query<Page<Endpoint>>}){
 const {t,locale}=useI18n();
 const can=(permission:string)=>session.permissions.includes(permission);
 const summary=useApi<{endpoints:number;operations:number}>('/workspaces/current/summary',5000,can('workspace:read'));
 const nodes=useApi<Page<Node>>('/nodes',5000,can('node:read'),true);
 const providers=useApi<Page<Provider>>('/providers',10000,can('provider:read'),true);
 const [now,setNow]=useState(Date.now()),[secret,setSecret]=useState<string>(),[enrolling,setEnrolling]=useState(false),[enrollError,setEnrollError]=useState<unknown>();
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[]);
 const sections=[...(can('endpoint:read')?[{id:'resources',label:t('system.resources')}]:[]),...(can('node:read')?[{id:'nodes',label:t('nav.agentNodes')}]:[]),...(can('provider:read')?[{id:'integrations',label:t('system.integrations')}]:[])];
 const params=new URLSearchParams(path.split('?')[1]),requested=params.get('section');
 const section=sections.find(item=>item.id===requested)?.id??sections[0]?.id;
 const selectedNode=params.get('node');
 const refreshing=[summary,nodes,providers,endpoints].some(q=>q.refreshing);
 const refresh=()=>Promise.all([can('workspace:read')?summary.refresh():null,can('node:read')?nodes.refresh():null,can('provider:read')?providers.refresh():null,can('endpoint:read')?endpoints.refresh():null]);
 const time=(value:string|null|undefined)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(locale):'—';
 const endpointFresh=!endpoints.error&&endpoints.data;
 const nodeFresh=!nodes.error&&nodes.data;
 const providerFresh=!providers.error&&providers.data;
 const counts=[
  ...(can('endpoint:read')?[{label:t('overview.protocolEndpoints'),value:endpointFresh?endpoints.data!.items.length:'—'},{label:t('system.readyEndpoints'),value:endpointFresh?endpoints.data!.items.filter(e=>e.status.node==='online'&&e.status.runtime==='ready').length:'—'}]:[]),
  ...(can('node:read')?[{label:t('system.onlineNodes'),value:nodeFresh?`${nodes.data!.items.filter(n=>nodeConnectionStatus(n)==='online').length} / ${nodes.data!.items.length}`:'—'}]:[]),
  ...(can('provider:read')?[{label:t('system.enabledIntegrations'),value:providerFresh?`${providers.data!.items.filter(p=>p.availability.enabled).length} / ${providers.data!.items.length}`:'—'}]:[]),
  ...(can('workspace:read')?[{label:t('system.changes'),value:summary.error?'—':summary.data?.operations??'—'}]:[]),
 ];
 async function enroll(){setEnrolling(true);setEnrollError(undefined);try{setSecret((await api.requestSecret<{token:string}>('/nodes/enrollment-tokens',{name:'agent',ttlSeconds:900,labels:{}})).token)}catch(error){setEnrollError(error)}finally{setEnrolling(false)}}
 return <Stack className="system-status">
  <PageHeading title={t('system.title')} action={<Button variant="outline" aria-label={t('system.refresh')} disabled={refreshing} onClick={()=>void refresh()}><RefreshCw className={refreshing?'refresh-spin':undefined}/>{t('common.refresh')}</Button>}/>
  <div className="system-summary">{counts.map(item=><div key={item.label}><small>{item.label}</small><strong>{item.value}</strong></div>)}</div>
  {summary.error?<Failure error={summary.error}/>:null}
  {section?<Tabs value={section} onValueChange={value=>navigate(value==='resources'?'/system-status':`/system-status?section=${value}`)}>
   <TabsList className="product-tabs-list system-tabs">{sections.map(item=><TabsTrigger key={item.id} value={item.id} className="product-tabs-trigger after:hidden">{item.label}</TabsTrigger>)}</TabsList>
   <TabsContent value="resources" className="system-panel">
    <div className="system-section-note"><span>{t('system.usageHint')}</span><span>{t('system.cpuHint')}</span></div>
    <Collection q={endpoints} empty={t('system.noEndpoints')}>{items=><Table headers={[t('endpoints.colName'),t('endpoints.colNode'),t('endpoints.colRuntime'),t('system.cpu'),t('system.memory'),t('system.sample')]} rows={items.map(endpoint=>{
     const sample=endpoint.metadata?.resourceUsage,state=resourceState(sample,endpoint.status.node,Boolean(endpoints.error),now),measured=state==='live'||state==='stale';
     return [<Link to={`/endpoints/${endpoint.id}`}>{endpoint.name}</Link>,<span>{endpoint.node?.name??t('common.unassigned')}<small className="system-cell-meta">{endpoint.providerId}</small></span>,<Badge good={!endpoints.error&&endpoint.status.node==='online'&&endpoint.status.runtime==='ready'}>{endpoints.error?t('sidebar.statusUnknown'):endpoint.status.runtime}</Badge>,<span className="system-metric">{measured?`${sample!.cpuPercent!.toFixed(2)}%`:'—'}<small className="system-cell-meta">/ {sample?.cpuLimitMillis?`${(sample.cpuLimitMillis/10).toFixed(0)}%`:'—'}</small></span>,<span className="system-metric">{measured?bytes(sample!.memoryBytes):'—'}<small className="system-cell-meta">/ {bytes(sample?.memoryLimitBytes)}</small></span>,<span><Badge good={state==='live'}>{t(`system.${state}`)}</Badge><small className="system-cell-meta">{time(sample?.observedAt)}</small></span>];
    })}/>}</Collection>
   </TabsContent>
   <TabsContent value="nodes" className="system-panel">
    {can('node:create')?<div className="system-section-actions"><Button variant="outline" busy={enrolling} onClick={()=>void enroll()}>{t('nodes.generateToken')}</Button></div>:null}
    {enrollError?<Failure error={enrollError}/>:null}
    <Collection q={nodes} empty={t('system.noNodes')}>{items=><Table headers={[t('nodes.colName'),t('nodes.colProvider'),t('nodes.colHeartbeat'),t('nodes.lastHeartbeat')]} rows={items.map(node=>[
     <details key={`${node.id}-${selectedNode??''}`} open={selectedNode===node.id}><summary>{node.name}</summary><dl className="system-node-detail"><dt>ID</dt><dd>{node.id}</dd><dt>{t('nodes.agentConfigured')}</dt><dd>{node.configured?t('common.yes'):t('common.no')}</dd><dt>{t('system.epoch')}</dt><dd>{node.connectionEpoch??'—'}</dd>{node.lastSeenAt?<><dt>{t('nodes.lastSeen')}</dt><dd>{time(node.lastSeenAt)}</dd></>:null}</dl></details>,node.provider,<Badge good={!nodes.error&&nodeConnectionStatus(node)==='online'}>{nodes.error?t('sidebar.statusUnknown'):nodeConnectionStatus(node)}</Badge>,time(node.lastHeartbeatAt)
    ])}/>}</Collection>
   </TabsContent>
   <TabsContent value="integrations" className="system-panel">
    <Collection q={providers} empty={t('system.noIntegrations')}>{items=><Table headers={[t('providers.colProvider'),t('providers.colAvailability'),t('providers.colCapabilities')]} rows={items.map(provider=>[provider.id,<Badge good={!providers.error&&provider.availability.enabled}>{providers.error?t('sidebar.statusUnknown'):provider.availability.enabled?t('common.enabled'):provider.availability.reason??t('common.disabled')}</Badge>,provider.capabilities.join(', ')])}/>}</Collection>
   </TabsContent>
  </Tabs>:null}
  <Modal open={Boolean(secret)} title={t('nodes.tokenTitle')} description={t('nodes.tokenDescription')} onClose={()=>setSecret(undefined)} footer={<Button onClick={()=>setSecret(undefined)}>{t('common.done')}</Button>}><code className="enrollment-token">{secret}</code></Modal>
 </Stack>;
}
