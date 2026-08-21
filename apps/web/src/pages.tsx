import {useEffect,useRef,useState,type ReactNode} from 'react';import {QRCodeSVG} from 'qrcode.react';import {api} from './api';import {ENDPOINTS_CHANGED} from './app';import {useApi} from './hooks';import {actionAvailability,nodeConnectionStatus,statusLayers} from './policy';import {SchemaForm} from './schema-form';import {Empty,Failure,Loading} from './states';import type {Credential,Endpoint,Node,Operation,Page,Provider,ResendSettings,SchemaField,Session} from './types';import {Badge,Button,Card,Input,Link,Modal,PageHeading,Select,Stack,Table,navigate} from './ui';import {Tabs,TabsContent,TabsList,TabsTrigger} from './components/tabs';import {WebSocketConnectionEditor,type WsClient,type WsServer} from './websocket-editor';
const State=<T,>({q,children}:{q:ReturnType<typeof useApi<T>>;children:(x:T)=>ReactNode})=>q.loading?<Loading/>:q.error?<Failure error={q.error}/>:children(q.data!);
const Info=({label,children}:{label:string;children:ReactNode})=><div className="info"><small>{label}</small><div>{children}</div></div>;
export function Overview(){const q=useApi<{endpoints:number;operations:number}>('/workspaces/current/summary');return <Stack><PageHeading title="Cluster" description="OneBot endpoints and recent control-plane activity."/><State q={q}>{d=><div className="summary-grid"><Card><span className="muted">Protocol endpoints</span><strong className="summary-value">{d.endpoints}</strong><small>Managed OneBot services</small></Card><Card><span className="muted">Changes</span><strong className="summary-value">{d.operations}</strong><small>Recorded desired-state operations</small></Card></div>}</State></Stack>}
export function Endpoints({session}:{session:Session}){
 const q=useApi<Page<Endpoint>>('/endpoints'),nodes=useApi<Page<Node>>('/nodes');
 const[open,setOpen]=useState(false),[provider,setProvider]=useState(''),[nodeId,setNodeId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>();
 const fields:SchemaField[]=[{key:'name',label:'Name',type:'string',required:true},...(provider?session.capabilities.configurationSchemas?.[provider]??[]:[])];
 async function create(values:Record<string,unknown>){setBusy(true);try{const ep=await api.mutate<Endpoint>('/endpoints',{providerId:provider,nodeId,...values});dispatchEvent(new Event(ENDPOINTS_CHANGED));navigate(`/endpoints/${ep.id}`)}catch(e){setError(e)}finally{setBusy(false)}}
 if(q.loading||nodes.loading)return <Loading/>;if(q.error||nodes.error)return <Failure error={q.error??nodes.error}/>;
 const canCreate=actionAvailability('create',{permissions:session.permissions,capabilities:session.capabilities,activeOperationId:null}).visible;
 return <Stack>
  <PageHeading kicker="Cluster resources" title="Protocol endpoints" description="Each endpoint is one managed OneBot protocol service hosted on an agent node." action={canCreate?<Button onClick={()=>setOpen(true)}>Create endpoint</Button>:undefined}/>
  {q.data!.items.length===0?<Empty name="endpoints"/>:<Table headers={['Name','Provider','Node','Node status','Runtime','Provider status','Protocol','Convergence']} rows={q.data!.items.map(ep=>[<Link to={`/endpoints/${ep.id}`}>{ep.name}</Link>,ep.providerId,ep.node?.name??'Unassigned',...statusLayers(ep.status).map(x=><Badge good={['connected','online','ready','available','converged'].includes(x.value)}>{x.value}</Badge>)])}/>}
  <Modal open={open} onClose={()=>{setOpen(false);setProvider('')}} title={provider?'Configure endpoint':'Create endpoint'}>
   {!provider?<Stack>{Object.entries(session.capabilities.providers??{}).map(([providerId,gate])=><div key={providerId}><Button disabled={!gate.enabled} onClick={()=>setProvider(providerId)}>{providerId==='napcat'?'NapCat':providerId==='fake'?'Fake':providerId}</Button>{gate.reason?<small>{gate.reason}</small>:null}</div>)}</Stack>:<Stack><Select label="Node" required value={nodeId} onChange={e=>setNodeId(e.currentTarget.value)}><option value="">Select node…</option>{nodes.data!.items.map(n=><option value={n.id} key={n.id}>{n.name}</option>)}</Select><SchemaForm fields={fields} submitLabel="Create" busy={busy} onSubmit={v=>{if(nodeId)void create(v)}}/>{error?<Failure error={error}/>:null}</Stack>}
  </Modal>
 </Stack>;
}
type OneBotProbe={ok:boolean;durationMs:number;error:string|null};
type OneBotDirectoryCollection={count:number;items:Record<string,unknown>[];truncated:boolean;observedAt:string|null;probe:OneBotProbe};
type NapCatStatus={qq:null|Record<string,unknown>;onebot:null|{status?:Record<string,unknown>;loginInfo?:Record<string,unknown>;version?:Record<string,unknown>;probes?:Record<string,OneBotProbe>;directory?:{friends:OneBotDirectoryCollection;groups:OneBotDirectoryCollection};config?:{websocketClients?:WsClient[];websocketServers?:WsServer[]}}};
export function EndpointDetail({session,id}:{session:Session;id:string}){
  const q=useApi<Endpoint>(`/endpoints/${id}`);
  const canOperate=session.permissions.includes('endpoint:start');
  const napcat=useApi<NapCatStatus>(`/endpoints/${id}/napcat/status`,3000,canOperate&&q.data?.providerId==='napcat');
  const [clients,setClients]=useState<WsClient[]>([]);
  const [servers,setServers]=useState<WsServer[]>([]);
  const [wsDirty,setWsDirty]=useState(false);
  const wsDirtyRef=useRef(false);
  const [logs,setLogs]=useState<string>();
  const [busy,setBusy]=useState('');
  const [error,setError]=useState<unknown>();
  const [directory,setDirectory]=useState<'friends'|'groups'>('friends');
  const ep=q.data;
  const qq=napcat.data?.qq;
  const onebot=napcat.data?.onebot;
  const loggedIn=qq?.online===true||onebot?.status?.online===true;
  const qr=useApi<{qrcode:string}>(canOperate&&ep?.providerId==='napcat'&&!loggedIn?`/endpoints/${id}/napcat/login-qrcode`:'/disabled',5000);

  useEffect(()=>{
    const config=napcat.data?.onebot?.config;
    if(config&&!wsDirtyRef.current){
      setClients(config.websocketClients??[]);
      setServers(config.websocketServers??[]);
    }
  },[napcat.data?.onebot?.config,wsDirty]);

  async function wait(op:Operation,message:string){
    for(let i=0;i<30;i++){
      await new Promise(resolve=>setTimeout(resolve,500));
      const current=await api.get<Operation>(`/operations/${op.id}`);
      if(['failed','stale'].includes(current.status))throw new Error(message);
      if(current.status==='succeeded')return current;
    }
    throw new Error(`${message}: timed out`);
  }
  async function run(name:string,fn:()=>Promise<void>){
    setBusy(name);setError(undefined);
    try{await fn()}catch(cause){setError(cause)}finally{setBusy('')}
  }
  async function saveWs(){
    await run('ws',async()=>{
      const clean=<T extends {tokenConfigured?:boolean}>(value:T)=>{const next={...value};delete next.tokenConfigured;return next};
      const op=await api.mutate<Operation>(`/endpoints/${id}/napcat/onebot/websockets`,{websocketClients:clients.map(clean),websocketServers:servers.map(clean)},'PUT');
      await wait(op,'WebSocket configuration failed');
      await Promise.all([napcat.refresh(),q.refresh()]);
      wsDirtyRef.current=false;
      setWsDirty(false);
    });
  }

  if(q.loading)return <Loading/>;
  if(q.error)return <Failure error={q.error}/>;
  const endpoint=q.data!;
  const markClients=(value:WsClient[])=>{wsDirtyRef.current=true;setWsDirty(true);setClients(value)};
  const markServers=(value:WsServer[])=>{wsDirtyRef.current=true;setWsDirty(true);setServers(value)};
  const discardWs=()=>{wsDirtyRef.current=false;setWsDirty(false)};
  const settings=<EndpointSettings endpoint={endpoint} refresh={q.refresh}/>;
  const lifecycleActions=<div className="endpoint-lifecycle-actions" aria-label="Endpoint lifecycle">{['start','stop','restart'].map(action=>{const availability=actionAvailability(action,{permissions:session.permissions,capabilities:session.capabilities,activeOperationId:endpoint.activeOperationId});return availability.visible&&<Button key={action} variant={action==='start'?'default':'outline'} busy={busy===`lifecycle-${action}`} disabled={availability.disabled||Boolean(busy)} onClick={()=>run(`lifecycle-${action}`,async()=>{const operation=await api.mutate<Operation>(`/endpoints/${endpoint.id}/operations`,{action,expectedGeneration:endpoint.generation});navigate(`/operations/${operation.id}`)})}>{action[0]!.toUpperCase()+action.slice(1)}</Button>})}</div>;
  const probeCatalog=[
    ['get_status','Runtime observation'],
    ['get_login_info','Account identity'],
    ['get_version_info','Implementation metadata'],
    ['get_friend_list','QQ directory'],
    ['get_group_list','QQ directory'],
  ] as const;
  const directoryData=onebot?.directory;
  const currentDirectory=directoryData?.[directory];
  const probeRows=probeCatalog.map(([action,category])=>{const probe=onebot?.probes?.[action];return [<code>{action}</code>,category,probe?<Badge good={probe.ok}>{probe.ok?'Available':'Failed'}</Badge>:<Badge>Not observed</Badge>,probe?`${probe.durationMs} ms${probe.error?` · ${probe.error}`:''}`:'—']});

  return <Stack className="endpoint-console">
    <PageHeading className="endpoint-heading" kicker="OneBot protocol endpoint · NapCat driver" title={endpoint.name} description={`Hosted by ${endpoint.node?.name??'an unassigned agent node'} · ${endpoint.id}`} action={lifecycleActions}/>
    <div className="health-strip">{statusLayers(endpoint.status).map(layer=><Info key={layer.label} label={layer.label}><Badge good={['connected','online','ready','available','converged'].includes(layer.value)}>{layer.value}</Badge></Info>)}</div>
    {endpoint.activeOperationId&&<div className="alert">Operation in progress. Actions are disabled until <Link to={`/operations/${endpoint.activeOperationId}`}>{endpoint.activeOperationId}</Link> completes.</div>}
    {canOperate&&endpoint.providerId==='napcat'?<Tabs defaultValue="overview" className="endpoint-tabs">
      <TabsList className="endpoint-tabs-list product-tabs-list">
        <TabsTrigger className="product-tabs-trigger after:hidden" value="overview">Overview</TabsTrigger>
        <TabsTrigger className="product-tabs-trigger after:hidden" value="qq-data" disabled={!loggedIn}>QQ data</TabsTrigger>
        <TabsTrigger className="product-tabs-trigger after:hidden" value="onebot" disabled={!loggedIn}>OneBot</TabsTrigger>
        <TabsTrigger className="product-tabs-trigger after:hidden" value="connections" disabled={!loggedIn}>Connections</TabsTrigger>
        <TabsTrigger className="product-tabs-trigger after:hidden" value="logs">Logs</TabsTrigger>
        <TabsTrigger className="product-tabs-trigger after:hidden" value="settings">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="endpoint-tab-panel">
        <Card className="qq-account-card"><div className="card-section-heading"><div><h2>QQ account</h2><p className="muted">Identity and login state for the QQ session managed by this endpoint.</p></div>{loggedIn&&<Badge good>Logged in</Badge>}</div>{loggedIn?<div className="info-grid"><Info label="Nickname">{String(qq?.nickname??qq?.nick??onebot?.loginInfo?.nickname??'QQ account')}</Info><Info label="QQ number">{String(qq?.uin??qq?.uid??onebot?.loginInfo?.user_id??'—')}</Info></div>:<div className="qq-login-panel"><div className="endpoint-qr">{qr.data?.qrcode?<QRCodeSVG value={qr.data.qrcode} size={184} role="img" aria-label="NapCat QR code"/>:<span>Waiting for a QR code.</span>}</div><div className="qq-login-copy"><h3>Scan with the QQ mobile app</h3><p className="muted">Open QQ, scan this code, then confirm the login on your phone. The status updates automatically; refresh only if the code expires.</p><Button busy={busy==='qr'} disabled={Boolean(endpoint.activeOperationId)} onClick={()=>run('qr',async()=>{await wait(await api.mutate<Operation>(`/endpoints/${id}/napcat/login-qrcode`),'QR refresh failed');await Promise.all([qr.refresh(),napcat.refresh(),q.refresh()])})}>Refresh QR code</Button></div></div>}</Card>
      </TabsContent>
      <TabsContent value="qq-data" className="endpoint-tab-panel">
        <Card><div className="card-section-heading"><div><h2>QQ account data</h2><p className="muted">Account-owned directory content retrieved through OneBot. It is kept separate from protocol operations and transport configuration.</p></div>{currentDirectory?.observedAt?<small className="muted">Observed {new Date(currentDirectory.observedAt).toLocaleString()}</small>:null}</div><Tabs value={directory} onValueChange={value=>setDirectory(value as 'friends'|'groups')}><TabsList className="product-tabs-list"><TabsTrigger className="product-tabs-trigger after:hidden" value="friends">Friends ({directoryData?.friends.count??0})</TabsTrigger><TabsTrigger className="product-tabs-trigger after:hidden" value="groups">Groups ({directoryData?.groups.count??0})</TabsTrigger></TabsList>{currentDirectory&&!currentDirectory.probe.ok?<div className="alert error" role="status">Latest refresh failed{currentDirectory.observedAt?'; showing the last successful result':''}. {currentDirectory.probe.error}</div>:null}{currentDirectory?.truncated?<p className="muted">Showing the first {currentDirectory.items.length} of {currentDirectory.count} entries.</p>:null}<TabsContent value="friends">{directoryData?.friends.items.length?<Table headers={['Nickname','Remark','QQ']} rows={directoryData.friends.items.map(friend=>[String(friend.nickname??'—'),String(friend.remark??'—'),String(friend.user_id)])}/>:<Empty name="friends"/>}</TabsContent><TabsContent value="groups">{directoryData?.groups.items.length?<Table headers={['Group','Members','ID']} rows={directoryData.groups.items.map(group=>[String(group.group_name??'—'),String(group.member_count??'—'),String(group.group_id)])}/>:<Empty name="groups"/>}</TabsContent></Tabs></Card>
      </TabsContent>
      <TabsContent value="onebot" className="endpoint-tab-panel">
        <Card className="protocol-runtime"><div><h2>OneBot protocol</h2><p>NapCat implements the OneBot 11 action interface for this QQ account. Internal action availability is shown here; transport configuration and peer reachability remain separate under Connections.</p></div><div className="runtime-facts"><Info label="Implementation">{String(onebot?.version?.app_name??'NapCat')}</Info><Info label="Implementation version">{String(onebot?.version?.app_version??'Awaiting runtime report')}</Info></div></Card>
        <Card><div className="card-section-heading"><div><h2>Protocol action support</h2><p className="muted">Observed read actions use an extensible typed catalog. Mutating actions will be added as explicit audited capabilities rather than an unrestricted action proxy.</p></div></div><Table headers={['Action','Layer','Availability','Latest probe']} rows={probeRows}/></Card>
      </TabsContent>
      <TabsContent value="connections" className="endpoint-tab-panel">
        <Card className="ws-transport-card"><PageHeading kicker="OneBot transport" title="WebSocket connections" description="Configure outbound consumers and inbound listeners without interrupting background status updates."/><fieldset className="ws-editor-fieldset" disabled={busy==='ws'}><WebSocketConnectionEditor clients={clients} servers={servers} onClientsChange={markClients} onServersChange={markServers}/></fieldset><footer className="ws-save-bar"><p>{wsDirty?'Unsaved WebSocket changes':'Configuration is synchronized with NapCat.'}</p><div className="ws-save-actions"><Button variant="outline" disabled={!wsDirty||busy==='ws'} onClick={discardWs}>Discard changes</Button><Button busy={busy==='ws'} disabled={Boolean(endpoint.activeOperationId)||!wsDirty} onClick={saveWs}>Save changes</Button></div></footer></Card>
      </TabsContent>
      <TabsContent value="logs" className="endpoint-tab-panel"><Card><h2>Container logs</h2><p className="muted">Last 250 lines from the past 15 minutes · credentials redacted</p><Button busy={busy==='logs'} disabled={Boolean(endpoint.activeOperationId)} onClick={()=>run('logs',async()=>{const current=await wait(await api.mutate<Operation>(`/endpoints/${id}/napcat/container-logs`,{tail:250,sinceSeconds:900}),'Container log request failed');setLogs((current.result as {metadata?:{logs?:{text?:string}}})?.metadata?.logs?.text??'No container logs returned.')})}>Load container logs</Button>{logs!==undefined&&<pre>{logs}</pre>}</Card></TabsContent>
      <TabsContent value="settings" className="endpoint-tab-panel">{settings}</TabsContent>
    </Tabs>:settings}
    {error?<Failure error={error}/>:null}
  </Stack>;
}

function EndpointSettings({endpoint,refresh}:{endpoint:Endpoint;refresh:()=>Promise<void>}){const[name,setName]=useState(endpoint.name),[busy,setBusy]=useState(false);return <Card><h2>Endpoint settings</h2><form className="inline-form" onSubmit={async e=>{e.preventDefault();setBusy(true);try{await api.mutate(`/endpoints/${endpoint.id}`,{name},'PATCH');await refresh();dispatchEvent(new Event(ENDPOINTS_CHANGED))}finally{setBusy(false)}}}><Input label="Name" value={name} onChange={e=>setName(e.currentTarget.value)}/><Button type="submit" busy={busy}>Rename</Button></form></Card>}

export function Nodes({session}:{session:Session}){const q=useApi<Page<Node>>('/nodes');const[secret,setSecret]=useState<string>(),[error,setError]=useState<unknown>();return <Stack><PageHeading kicker="Cluster infrastructure" title="Agent nodes" description="Machines running the Botroost agent." action={session.permissions.includes('node:create')?<Button onClick={async()=>{try{setSecret((await api.requestSecret<{token:string}>('/nodes/enrollment-tokens',{name:'agent',ttlSeconds:900,labels:{}})).token)}catch(e){setError(e)}}}>Generate enrollment token</Button>:undefined}/><State q={q}>{d=>d.items.length?<Table headers={['Name','Provider','Heartbeat']} rows={d.items.map(n=>[<Link to={`/nodes/${n.id}`}>{n.name}</Link>,n.provider,<Badge good={nodeConnectionStatus(n)==='online'}>{nodeConnectionStatus(n)}</Badge>])}/>:<Empty name="nodes"/>}</State>{error?<Failure error={error}/>:null}<Modal open={Boolean(secret)} title="One-time enrollment token" onClose={()=>setSecret(undefined)}><code>{secret}</code><p>Copy it now. It will not be shown again.</p></Modal></Stack>}
export function NodeDetail({id}:{id:string}){const q=useApi<Node>(`/nodes/${id}`);return <Stack><PageHeading kicker="Cluster infrastructure" title="Agent node"/><State q={q}>{n=><Card><h2>{n.name}</h2><div className="info-grid"><Info label="Runtime driver">{n.provider}</Info><Info label="Agent configured">{n.configured?'Yes':'No'}</Info><Info label="Last heartbeat">{n.lastHeartbeatAt??'Never'}</Info><Info label="Last seen">{n.lastSeenAt??'Never'}</Info></div></Card>}</State></Stack>}
export function Providers(){const q=useApi<Page<Provider>>('/providers');return <Stack><PageHeading kicker="Runtime integration" title="Runtime drivers"/><State q={q}>{d=>d.items.length?<Table headers={['Provider','Capabilities','Availability']} rows={d.items.map(p=>[p.id,p.capabilities.join(', '),<Badge good={p.availability.enabled}>{p.availability.enabled?'enabled':p.availability.reason??'disabled'}</Badge>])}/>:<Empty name="providers"/>}</State></Stack>}
export function Operations(){const q=useApi<Page<Operation>>('/operations');return <Stack><PageHeading kicker="Desired-state history" title="Changes"/><State q={q}>{d=>d.items.length?<Table headers={['Operation','Endpoint','State','Created']} rows={d.items.map(o=>[<Link to={`/operations/${o.id}`}>{o.action??o.id}</Link>,o.endpointId,<Badge>{o.status}</Badge>,o.createdAt??'—'])}/>:<Empty name="operations"/>}</State></Stack>}
export function OperationDetail({id}:{id:string}){const q=useApi<Operation>(`/operations/${id}`,data=>data&&['queued','running'].includes(data.status)?2000:undefined);return <Stack><PageHeading kicker="Desired-state change" title="Operation detail"/><State q={q}>{o=><><Card><div className="info-grid"><Info label="Action">{o.action}</Info><Info label="Status">{o.status}</Info><Info label="Endpoint"><Link to={`/endpoints/${o.endpointId}`}>{o.endpointId}</Link></Info><Info label="Generation">{o.generation}</Info></div></Card>{o.result!==undefined&&<Card><pre>{JSON.stringify(o.result,null,2)}</pre></Card>}</>}</State></Stack>}
function Collection({title,path}:{title:string;path:string}){const q=useApi<Page<Record<string,unknown>>>(path);return <Stack><PageHeading title={title}/><State q={q}>{d=>d.items.length?<Table headers={['Name','Detail']} rows={d.items.map(x=>[String(x.action??x.name??x.email??x.id),String(x.role??x.resource_type??x.createdAt??x.created_at??'')])}/>:<Empty name={title}/>}</State></Stack>}
export const Audit=()=> <Collection title="Audit events" path="/audit"/>;
function WorkspaceNav({session}:{session:Session}){return <div className="subnav">{([['Members','/workspace/members','member:read'],['Credentials','/workspace/credentials','credential:read'],['Settings','/workspace/settings','settings:read']] as const).filter(x=>session.permissions.includes(x[2])).map(x=><Link key={x[1]} to={x[1]}>{x[0]}</Link>)}</div>}
export const Members=({session}:{session:Session})=><Stack><WorkspaceNav session={session}/><Collection title="Workspace members" path="/workspaces/current/members"/></Stack>;
export function Credentials({session}:{session:Session}){const q=useApi<Page<Credential>>('/workspaces/current/credentials');const[name,setName]=useState(''),[value,setValue]=useState('');return <Stack><WorkspaceNav session={session}/><PageHeading title="Credentials"/><State q={q}>{d=>d.items.length?<Table headers={['Name','Status']} rows={d.items.map(x=>[x.name,x.configured?'Configured':'Missing'])}/>:<Empty name="credentials"/>}</State>{session.permissions.includes('credential:manage')&&<form className="inline-form" onSubmit={async e=>{e.preventDefault();await api.mutate('/workspaces/current/credentials',{name,value});setName('');setValue('');await q.refresh()}}><Input label="Name" required value={name} onChange={e=>setName(e.currentTarget.value)}/><Input label="Secret value" type="password" required value={value} onChange={e=>setValue(e.currentTarget.value)}/><Button type="submit">Add credential</Button></form>}</Stack>}
export function Settings({session}:{session:Session}){const q=useApi<ResendSettings>('/workspaces/current/settings/resend');const[form,setForm]=useState<(ResendSettings&{apiKey:string})>();useEffect(()=>{if(q.data)setForm({...q.data,apiKey:''})},[q.data]);if(q.loading||!form)return <Loading/>;if(q.error)return <Failure error={q.error}/>;const can=session.permissions.includes('settings:manage');return <Stack><WorkspaceNav session={session}/><PageHeading title="Email alerts" description="Email workspace admins when a NapCat node stays offline, then when it recovers."/><label className="check"><input type="checkbox" checked={form.enabled} disabled={!can} onChange={e=>setForm({...form,enabled:e.currentTarget.checked})}/>Enable alerts</label><Input label="Recipient" type="email" disabled={!can} value={form.recipient} onChange={e=>setForm({...form,recipient:e.currentTarget.value})}/><Input label="From" disabled={!can} value={form.from} onChange={e=>setForm({...form,from:e.currentTarget.value})}/><Input label="Offline grace (seconds)" type="number" disabled={!can} value={form.graceSeconds} onChange={e=>setForm({...form,graceSeconds:Number(e.currentTarget.value)})}/><Input label="Resend API key" type="password" placeholder={q.data!.apiKeyConfigured?'Leave blank to keep current key':'re_…'} disabled={!can} value={form.apiKey} onChange={e=>setForm({...form,apiKey:e.currentTarget.value})}/>{can&&<div className="actions"><Button onClick={async()=>{const{apiKey,...settings}=form;await api.mutate('/workspaces/current/settings/resend',apiKey?{...settings,apiKey}:settings,'PUT');await q.refresh()}}>Save settings</Button><Button onClick={()=>api.mutate('/workspaces/current/settings/resend/test')}>Send test</Button></div>}</Stack>}
