import {Alert,Badge,Button,Group,Modal,Stack,Table,Text,Title} from '@mantine/core';
import {useMemo,useState} from 'react';
import {Link,useNavigate,useParams} from 'react-router-dom';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import type {ColumnDef} from '@tanstack/react-table';
import {api,ApiError} from './api';
import {DataTable} from './data-table';
import {SchemaForm} from './schema-form';
import {Empty,Failure,Loading,Unavailable} from './states';
import {actionAvailability,statusLayers} from './policy';
import type {Endpoint,Node,Operation,Page,SchemaField,Session} from './types';

const query=(key:string,path:string)=>useQuery({queryKey:[key],queryFn:()=>api.get<unknown>(path),retry:false});
const unavailable=(error:unknown)=>error instanceof ApiError&&error.status===404;

export function Overview(){const q=query('overview','/overview');return <Stack><Title order={2}>Operational overview</Title>{q.isLoading?<Loading/>:unavailable(q.error)?<Unavailable/>:q.error?<Failure error={q.error}/>:<pre>{JSON.stringify(q.data,null,2)}</pre>}</Stack>}

export function Endpoints({session}:{session:Session}){
  const q=useQuery({queryKey:['endpoints'],queryFn:()=>api.get<Page<Endpoint>>('/endpoints'),retry:false});
  const [provider,setProvider]=useState<string>();
  const navigate=useNavigate();
  const create=useMutation({mutationFn:(values:Record<string,unknown>)=>api.mutate<Endpoint>('/endpoints',{providerId:provider,...values}),onSuccess:endpoint=>navigate(`/endpoints/${endpoint.id}`)});
  const columns=useMemo<ColumnDef<Endpoint>[]>(()=>[
    {header:'Name',accessorKey:'name',cell:info=><Link to={`/endpoints/${info.row.original.id}`}>{String(info.getValue())}</Link>},
    {header:'Provider',accessorKey:'providerId'},
    ...statusLayers({node:'',runtime:'',provider:'',protocol:'',convergence:''}).map(layer=>({header:layer.label,cell:({row}:{row:{original:Endpoint}})=><Badge variant="light">{statusLayers(row.original.status).find(item=>item.label===layer.label)?.value}</Badge>})),
  ],[]);
  if(q.isLoading)return <Loading/>;if(q.error)return unavailable(q.error)?<Unavailable/>:<Failure error={q.error}/>;
  const data=q.data!;const fields:SchemaField[]=[{key:'name',label:'Name',type:'string',required:true},...(session.capabilities.configurationSchema??[])];
  return <Stack><Group justify="space-between"><Title order={2}>Endpoints</Title>{actionAvailability('create',{permissions:session.permissions,capabilities:session.capabilities,activeOperationId:null}).visible&&<Button onClick={()=>setProvider('')}>Create endpoint</Button>}</Group>{data.items.length===0?<Empty name="endpoints"/>:<DataTable data={data.items} columns={columns}/>}<Modal opened={provider!==undefined} onClose={()=>setProvider(undefined)} title={provider?'Configure endpoint':'Create endpoint'}>
    {!provider?<Stack>{Object.entries(session.capabilities.providers??{}).map(([id,gate])=><div key={id}><Button fullWidth disabled={!gate.enabled} onClick={()=>gate.enabled&&setProvider(id)}>{id==='napcat'?'NapCat':id==='fake'?'Fake':id}</Button>{gate.reason&&<Text size="sm" c="dimmed">{gate.reason}</Text>}</div>)}</Stack>:<SchemaForm fields={fields} submitLabel="Create" busy={create.isPending} onSubmit={values=>create.mutate(values)}/>} {create.error&&<Failure error={create.error}/>} 
  </Modal></Stack>;
}

export function EndpointDetail({session}:{session:Session}){
  const {id}=useParams();const nav=useNavigate();const client=useQueryClient();
  const q=useQuery({queryKey:['endpoint',id],queryFn:()=>api.get<Endpoint>(`/endpoints/${id}`),retry:false});
  const op=useMutation({mutationFn:(kind:string)=>api.mutate<Operation>('/operations',{endpointId:id,kind}),onSuccess:value=>nav(`/operations/${value.id}`)});
  const save=useMutation({mutationFn:(configuration:Record<string,unknown>)=>api.mutate<Endpoint>(`/endpoints/${id}`,{configuration},'PATCH'),onSuccess:()=>client.invalidateQueries({queryKey:['endpoint',id]})});
  if(q.isLoading)return <Loading/>;if(q.error)return unavailable(q.error)?<Unavailable/>:<Failure error={q.error}/>;const ep=q.data!;
  return <Stack><Title order={2}>{ep.name}</Title><Group>{statusLayers(ep.status).map(layer=><Badge key={layer.label}>{layer.label}: {layer.value}</Badge>)}</Group>{ep.activeOperationId&&<Alert color="yellow" title="Operation in progress">Conflicting actions are disabled until <Link to={`/operations/${ep.activeOperationId}`}>{ep.activeOperationId}</Link> completes.</Alert>}<Title order={3}>Configuration</Title>{session.capabilities.configurationSchema?.length?<SchemaForm fields={session.capabilities.configurationSchema.map(field=>({...field,value:ep.configuration?.[field.key]??field.value}))} submitLabel="Save configuration" busy={save.isPending} onSubmit={values=>save.mutate(values)}/>:<pre>{JSON.stringify(ep.configuration??{},null,2)}</pre>}<Title order={3}>Operations</Title><Group>{['start','stop','restart'].map(kind=>{const availability=actionAvailability(kind,{permissions:session.permissions,capabilities:session.capabilities,activeOperationId:ep.activeOperationId});return availability.visible?<Button key={kind} disabled={availability.disabled} onClick={()=>op.mutate(kind)}>{kind[0]!.toUpperCase()+kind.slice(1)}</Button>:null})}</Group>{(op.error||save.error)&&<Failure error={op.error??save.error}/>}</Stack>;
}

export function Nodes(){const q=useQuery({queryKey:['nodes'],queryFn:()=>api.get<Page<Node>>('/nodes'),retry:false});const [secret,setSecret]=useState<string>();const token=useMutation({mutationFn:()=>api.requestSecret<{token:string}>('/nodes/enrollment-token'),onSuccess:value=>setSecret(value.token)});if(q.isLoading)return <Loading/>;if(q.error)return unavailable(q.error)?<Unavailable/>:<Failure error={q.error}/>;return <Stack><Group justify="space-between"><Title order={2}>Nodes</Title><Button onClick={()=>token.mutate()}>Generate enrollment token</Button></Group>{q.data!.items.length===0?<Empty name="nodes"/>:<Table><Table.Thead><Table.Tr><Table.Th>Name</Table.Th><Table.Th>State</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{q.data!.items.map(node=><Table.Tr key={node.id}><Table.Td><Link to={`/nodes/${node.id}`}>{node.name}</Link></Table.Td><Table.Td><Badge>{node.state}</Badge></Table.Td></Table.Tr>)}</Table.Tbody></Table>}{token.error&&<Failure error={token.error}/>}<Modal opened={Boolean(secret)} onClose={()=>setSecret(undefined)} title="One-time enrollment token" closeButtonProps={{'aria-label':'Dismiss token'}}><Text ff="monospace">{secret}</Text><Text c="dimmed">Copy it now. It will not be shown again.</Text><Button mt="md" onClick={()=>setSecret(undefined)}>Close</Button></Modal></Stack>}

function Collection({title,path,links=false}:{title:string;path:string;links?:boolean}){const q=query(title,path);if(q.isLoading)return <Loading/>;if(q.error)return unavailable(q.error)?<Unavailable/>:<Failure error={q.error}/>;const items=(q.data as Page<Record<string,unknown>>).items;return <Stack><Title order={2}>{title}</Title>{items.length===0?<Empty name={title}/>:<Table><Table.Thead><Table.Tr><Table.Th>Name</Table.Th><Table.Th>State / date</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{items.map((item,index)=><Table.Tr key={String(item.id??index)}><Table.Td>{links&&item.id?<Link to={`${path}/${String(item.id)}`}>{String(item.name??item.kind??item.id)}</Link>:String(item.name??item.action??item.id)}</Table.Td><Table.Td>{String(item.state??item.createdAt??'')}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}</Stack>}
export const Providers=()=> <Collection title="Providers" path="/providers"/>;
export function Operations(){const q=useQuery({queryKey:['operations'],queryFn:()=>api.get<Page<Operation>>('/operations'),retry:false});const columns=useMemo<ColumnDef<Operation>[]>(()=>[{header:'Operation',accessorKey:'kind',cell:info=><Link to={`/operations/${info.row.original.id}`}>{String(info.getValue()??info.row.original.id)}</Link>},{header:'Endpoint',accessorKey:'endpointId'},{header:'State',accessorKey:'state',cell:info=><Badge>{String(info.getValue())}</Badge>},{header:'Created',accessorKey:'createdAt'}],[]);if(q.isLoading)return <Loading/>;if(q.error)return unavailable(q.error)?<Unavailable/>:<Failure error={q.error}/>;return <Stack><Title order={2}>Operations</Title>{q.data!.items.length?<DataTable data={q.data!.items} columns={columns}/>:<Empty name="operations"/>}</Stack>}
export const Audit=()=> <Collection title="Audit events" path="/audit"/>;export const Members=()=> <Collection title="Workspace members" path="/workspace/members"/>;export const Credentials=()=> <Collection title="Credentials" path="/workspace/credentials"/>;export const Settings=()=> <Collection title="Workspace settings" path="/workspace/settings"/>;
export function OperationDetail(){const {id}=useParams();const q=query(`operation-${id}`,`/operations/${id}`);if(q.isLoading)return <Loading/>;if(q.error)return unavailable(q.error)?<Unavailable/>:<Failure error={q.error}/>;return <Stack><Title order={2}>Operation detail</Title><pre>{JSON.stringify(q.data,null,2)}</pre></Stack>}
export function NodeDetail(){const {id}=useParams();const q=query(`node-${id}`,`/nodes/${id}`);if(q.isLoading)return <Loading/>;if(q.error)return unavailable(q.error)?<Unavailable/>:<Failure error={q.error}/>;return <Stack><Title order={2}>Node detail</Title><pre>{JSON.stringify(q.data,null,2)}</pre></Stack>}
