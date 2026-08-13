import {Alert,Badge,Button,Group,Modal,Select,Stack,Table,Text,TextInput,Title} from '@mantine/core';
import {useMemo,useState} from 'react';
import {Link,useNavigate,useParams} from 'react-router-dom';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import type {ColumnDef} from '@tanstack/react-table';
import {api} from './api';
import {DataTable} from './data-table';
import {SchemaForm} from './schema-form';
import {Empty,Failure,Loading} from './states';
import {actionAvailability,statusLayers} from './policy';
import type {Credential,Endpoint,Node,Operation,Page,Provider,SchemaField,Session} from './types';

const query=<T,>(key:string,path:string)=>useQuery({queryKey:[key],queryFn:()=>api.get<T>(path),retry:false});
const state=<T,>(q:{isLoading:boolean;error:Error|null;data:T|undefined},render:(data:T)=>React.ReactNode)=>q.isLoading?<Loading/>:q.error?<Failure error={q.error}/>:render(q.data!);

export function Overview(){const q=query<{endpoints:number;operations:number}>('overview','/workspaces/current/summary');return <Stack><Title order={2}>Operational overview</Title>{state(q,data=><Group><Alert title="Endpoints">{data.endpoints}</Alert><Alert title="Operations">{data.operations}</Alert></Group>)}</Stack>}

export function Endpoints({session}:{session:Session}){
  const q=query<Page<Endpoint>>('endpoints','/endpoints');
  const nodes=query<Page<Node>>('nodes-for-endpoint','/nodes');
  const [provider,setProvider]=useState<string>();
  const [nodeId,setNodeId]=useState<string|null>(null);
  const navigate=useNavigate();
  const create=useMutation({mutationFn:(values:Record<string,unknown>)=>api.mutate<Endpoint>('/endpoints',{providerId:provider,nodeId,...values}),onSuccess:endpoint=>navigate(`/endpoints/${endpoint.id}`)});
  const columns=useMemo<ColumnDef<Endpoint>[]>(()=>[
    {header:'Name',accessorKey:'name',cell:info=><Link to={`/endpoints/${info.row.original.id}`}>{String(info.getValue())}</Link>},
    {header:'Provider',accessorKey:'providerId'},
    {header:'Node',cell:info=>info.row.original.node?.name??'Unassigned'},
    ...statusLayers({node:'',runtime:'',provider:'',protocol:'',convergence:''}).map(layer=>({header:layer.label,cell:({row}:{row:{original:Endpoint}})=><Badge variant="light">{statusLayers(row.original.status).find(item=>item.label===layer.label)?.value}</Badge>})),
  ],[]);
  if(q.isLoading||nodes.isLoading)return <Loading/>;if(q.error||nodes.error)return <Failure error={q.error??nodes.error}/>;
  const fields:SchemaField[]=[{key:'name',label:'Name',type:'string',required:true},...(provider?session.capabilities.configurationSchemas?.[provider]??[]:[])];
  const canCreate=actionAvailability('create',{permissions:session.permissions,capabilities:session.capabilities,activeOperationId:null}).visible;
  return <Stack><Group justify="space-between"><Title order={2}>Endpoints</Title>{canCreate&&<Button onClick={()=>setProvider('')}>Create endpoint</Button>}</Group>{q.data!.items.length===0?<Empty name="endpoints"/>:<DataTable data={q.data!.items} columns={columns}/>}<Modal opened={provider!==undefined} onClose={()=>{setProvider(undefined);setNodeId(null)}} title={provider?'Configure endpoint':'Create endpoint'}>
    {!provider?<Stack>{Object.entries(session.capabilities.providers??{}).map(([id,gate])=><div key={id}><Button fullWidth disabled={!gate.enabled} onClick={()=>gate.enabled&&setProvider(id)}>{id==='napcat'?'NapCat':id==='fake'?'Fake':id}</Button>{gate.reason&&<Text size="sm" c="dimmed">{gate.reason}</Text>}</div>)}</Stack>:<Stack><Select label="Node" required data={nodes.data!.items.map(node=>({value:node.id,label:node.name}))} value={nodeId} onChange={setNodeId}/><SchemaForm fields={fields} submitLabel="Create" busy={create.isPending} onSubmit={values=>nodeId&&create.mutate(values)}/></Stack>}{create.error&&<Failure error={create.error}/>}
  </Modal></Stack>;
}

export function EndpointDetail({session}:{session:Session}){
  const {id}=useParams();const nav=useNavigate();const client=useQueryClient();
  const q=query<Endpoint>(`endpoint-${id}`,`/endpoints/${id}`);
  const op=useMutation({mutationFn:(action:string)=>api.mutate<Operation>(`/endpoints/${id}/operations`,{action,expectedGeneration:q.data!.generation}),onSuccess:value=>nav(`/operations/${value.id}`)});
  const save=useMutation({mutationFn:(values:Record<string,unknown>)=>api.mutate<Endpoint>(`/endpoints/${id}`,{name:values.name},'PATCH'),onSuccess:()=>client.invalidateQueries({queryKey:[`endpoint-${id}`]})});
  if(q.isLoading)return <Loading/>;if(q.error)return <Failure error={q.error}/>;const ep=q.data!;
  const schema=session.capabilities.configurationSchemas?.[ep.providerId]??[];
  return <Stack><Title order={2}>{ep.name}</Title><Text>Node: {ep.node?.name??'Unassigned'}</Text><Group>{statusLayers(ep.status).map(layer=><Badge key={layer.label}>{layer.label}: {layer.value}</Badge>)}</Group>{ep.activeOperationId&&<Alert color="yellow" title="Operation in progress">Conflicting actions are disabled until <Link to={`/operations/${ep.activeOperationId}`}>{ep.activeOperationId}</Link> completes.</Alert>}<Title order={3}>Configuration</Title>{schema.length?<SchemaForm fields={schema.map(field=>({...field,value:ep.configuration?.[field.key]??field.value}))} submitLabel="Save configuration" busy={save.isPending} onSubmit={values=>save.mutate(values)}/>:<Text c="dimmed">This provider has no configurable fields.</Text>}<Title order={3}>Operations</Title><Group>{['start','stop','restart'].map(kind=>{const availability=actionAvailability(kind,{permissions:session.permissions,capabilities:session.capabilities,activeOperationId:ep.activeOperationId??null},ep.providerId);return availability.visible?<Button key={kind} disabled={availability.disabled} onClick={()=>op.mutate(kind)}>{kind[0]!.toUpperCase()+kind.slice(1)}</Button>:null})}</Group>{(op.error||save.error)&&<Failure error={op.error??save.error}/>}</Stack>;
}

export function Nodes({session}:{session:Session}){const q=query<Page<Node>>('nodes','/nodes');const [secret,setSecret]=useState<string>();const token=useMutation({mutationFn:()=>api.requestSecret<{token:string}>('/nodes/enrollment-tokens',{name:'agent',ttlSeconds:900,labels:{}}),onSuccess:value=>setSecret(value.token)});if(q.isLoading)return <Loading/>;if(q.error)return <Failure error={q.error}/>;const canManage=session.permissions.includes('node:create');return <Stack><Group justify="space-between"><Title order={2}>Nodes</Title>{canManage&&<Button onClick={()=>token.mutate()}>Generate enrollment token</Button>}</Group>{q.data!.items.length===0?<Empty name="nodes"/>:<Table><Table.Thead><Table.Tr><Table.Th>Name</Table.Th><Table.Th>Provider</Table.Th><Table.Th>Heartbeat</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{q.data!.items.map(node=><Table.Tr key={node.id}><Table.Td><Link to={`/nodes/${node.id}`}>{node.name}</Link></Table.Td><Table.Td>{node.provider}</Table.Td><Table.Td><Badge>{node.lastHeartbeatAt?'online':'waiting'}</Badge></Table.Td></Table.Tr>)}</Table.Tbody></Table>}{token.error&&<Failure error={token.error}/>}<Modal opened={Boolean(secret)} onClose={()=>setSecret(undefined)} title="One-time enrollment token" closeButtonProps={{'aria-label':'Dismiss token'}}><Text ff="monospace">{secret}</Text><Text c="dimmed">Copy it now. It will not be shown again.</Text><Button mt="md" onClick={()=>setSecret(undefined)}>Close</Button></Modal></Stack>}

export function Providers(){const q=query<Page<Provider>>('providers','/providers');return <Stack><Title order={2}>Providers</Title>{state(q,data=>data.items.length?<Table><Table.Thead><Table.Tr><Table.Th>Provider</Table.Th><Table.Th>Capabilities</Table.Th><Table.Th>Availability</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{data.items.map(p=><Table.Tr key={p.id}><Table.Td>{p.id}</Table.Td><Table.Td>{p.capabilities.join(', ')}</Table.Td><Table.Td><Badge color={p.availability.enabled?'green':'gray'}>{p.availability.enabled?'enabled':p.availability.reason??'disabled'}</Badge></Table.Td></Table.Tr>)}</Table.Tbody></Table>:<Empty name="providers"/>)}</Stack>}
export function Operations(){const q=query<Page<Operation>>('operations','/operations');const columns=useMemo<ColumnDef<Operation>[]>(()=>[{header:'Operation',accessorKey:'action',cell:info=><Link to={`/operations/${info.row.original.id}`}>{String(info.getValue()??info.row.original.id)}</Link>},{header:'Endpoint',accessorKey:'endpointId'},{header:'State',accessorKey:'status',cell:info=><Badge>{String(info.getValue())}</Badge>},{header:'Created',accessorKey:'createdAt'}],[]);return <Stack><Title order={2}>Operations</Title>{state(q,data=>data.items.length?<DataTable data={data.items} columns={columns}/>:<Empty name="operations"/>)}</Stack>}
function JsonCollection({title,path}:{title:string;path:string}){const q=query<Page<Record<string,unknown>>>(title,path);return <Stack><Title order={2}>{title}</Title>{state(q,data=>data.items.length?<Table><Table.Tbody>{data.items.map((item,index)=><Table.Tr key={String(item.id??index)}><Table.Td>{String(item.action??item.name??item.email??item.id)}</Table.Td><Table.Td>{String(item.role??item.resource_type??item.createdAt??item.created_at??'')}</Table.Td></Table.Tr>)}</Table.Tbody></Table>:<Empty name={title}/>)}</Stack>}
export const Audit=()=> <JsonCollection title="Audit events" path="/audit"/>;
export const Members=()=> <JsonCollection title="Workspace members" path="/workspaces/current/members"/>;
export function Credentials({session}:{session:Session}){const q=query<Page<Credential>>('credentials','/workspaces/current/credentials');const client=useQueryClient();const [name,setName]=useState('');const [value,setValue]=useState('');const create=useMutation({mutationFn:()=>api.mutate('/workspaces/current/credentials',{name,value}),onSuccess:()=>{setName('');setValue('');void client.invalidateQueries({queryKey:['credentials']})}});const canManage=session.permissions.includes('credential:manage');return <Stack><Title order={2}>Credentials</Title>{state(q,data=>data.items.length?<Table><Table.Tbody>{data.items.map(item=><Table.Tr key={item.id}><Table.Td>{item.name}</Table.Td><Table.Td>{item.configured?'Configured':'Missing'}</Table.Td></Table.Tr>)}</Table.Tbody></Table>:<Empty name="credentials"/>)}{canManage&&<form onSubmit={event=>{event.preventDefault();create.mutate()}}><Group align="end"><TextInput label="Name" required value={name} onChange={event=>setName(event.currentTarget.value)}/><TextInput label="Secret value" type="password" required value={value} onChange={event=>setValue(event.currentTarget.value)}/><Button type="submit" loading={create.isPending}>Add credential</Button></Group></form>}{create.error&&<Failure error={create.error}/>}</Stack>}
export function Settings(){const q=query<Record<string,unknown>>('settings','/workspaces/current/settings');return <Stack><Title order={2}>Workspace settings</Title>{state(q,data=>Object.keys(data).length?<pre>{JSON.stringify(data,null,2)}</pre>:<Empty name="settings"/>)}</Stack>}
export function OperationDetail(){const {id}=useParams();const q=query<Operation>(`operation-${id}`,`/operations/${id}`);return <Stack><Title order={2}>Operation detail</Title>{state(q,data=><pre>{JSON.stringify(data,null,2)}</pre>)}</Stack>}
export function NodeDetail(){const {id}=useParams();const q=query<Node>(`node-${id}`,`/nodes/${id}`);return <Stack><Title order={2}>Node detail</Title>{state(q,data=><pre>{JSON.stringify(data,null,2)}</pre>)}</Stack>}