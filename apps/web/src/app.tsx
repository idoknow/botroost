import '@mantine/core/styles.css';
import './styles.css';
import {ActionIcon,AppShell,Box,Burger,Divider,Group,MantineProvider,NavLink,Stack,Text,createTheme} from '@mantine/core';
import {useDisclosure} from '@mantine/hooks';
import {IconActivity,IconAdjustments,IconBuilding,IconCloud,IconDatabase,IconFileAnalytics,IconLogout2,IconServer,IconTopologyStar} from '@tabler/icons-react';
import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
import type {ReactNode} from 'react';
import {BrowserRouter,Link,Navigate,Route,Routes,useLocation,useNavigate} from 'react-router-dom';
import {api} from './api';
import {Login} from './login';
import {Audit,Credentials,EndpointDetail,Endpoints,Members,NodeDetail,Nodes,OperationDetail,Operations,Overview,Providers,Settings} from './pages';
import {Loading,NotFound} from './states';
import type {Session} from './types';
import {BrandMark,PageContainer} from './ui';

const theme=createTheme({
  primaryColor:'cyan',
  primaryShade:6,
  fontFamily:'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontFamilyMonospace:'"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
  headings:{fontFamily:'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',fontWeight:'560'},
  defaultRadius:'sm',
  radius:{xs:'4px',sm:'6px',md:'10px',lg:'10px',xl:'10px'},
  spacing:{xs:'8px',sm:'12px',md:'16px',lg:'24px',xl:'32px'},
  colors:{cyan:['#e5fbff','#c9f5ff','#98ebff','#60dcfb','#22c7ef','#09aeda','#008bb3','#06708e','#0a5c74','#0b4c61']},
  components:{Button:{defaultProps:{radius:'sm'}},Card:{defaultProps:{radius:'md',withBorder:true}},Paper:{defaultProps:{radius:'md'}},TextInput:{defaultProps:{radius:'sm'}},PasswordInput:{defaultProps:{radius:'sm'}},Select:{defaultProps:{radius:'sm'}},Modal:{defaultProps:{radius:'md',overlayProps:{backgroundOpacity:.72,blur:2}}}},
});

const newClient=()=>new QueryClient({defaultOptions:{queries:{staleTime:15_000,retry:false}}});
let activeClient:QueryClient|undefined;
const nav=[
  {label:'Overview',to:'/',permission:'workspace:read',icon:IconActivity},
  {label:'Endpoints',to:'/endpoints',permission:'endpoint:read',icon:IconTopologyStar},
  {label:'Nodes',to:'/nodes',permission:'node:read',icon:IconServer},
  {label:'Providers',to:'/providers',permission:'provider:read',icon:IconCloud},
  {label:'Operations',to:'/operations',permission:'operation:read',icon:IconDatabase},
  {label:'Audit',to:'/audit',permission:'audit:read',icon:IconFileAnalytics},
  {label:'Workspace',to:'/workspace/members',permission:'workspace:sensitive',icon:IconBuilding},
] as const;

const has=(session:Session,permission:string)=>permission==='workspace:sensitive'
  ? ['member:read','credential:read','settings:read'].some(item=>session.permissions.includes(item))
  : session.permissions.includes(permission);

function Guard({session,permission,children}:{session:Session;permission:string;children:ReactNode}){
  return has(session,permission)?children:<NotFound/>;
}

function Shell({session}:{session:Session}){
  const [opened,{toggle,close}]=useDisclosure(false);
  const location=useLocation();
  const navigate=useNavigate();
  async function logout(){await api.mutate('/auth/logout');activeClient?.clear();navigate('/login',{replace:true})}
  return <AppShell header={{height:56}} navbar={{width:224,breakpoint:'sm',collapsed:{mobile:!opened}}} padding={0}>
    <AppShell.Header className="app-header">
      <Group h="100%" px={{base:'sm',sm:'md'}} justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation"/>
          <BrandMark/>
          <Divider orientation="vertical" h={24} visibleFrom="sm"/>
          <Text className="workspace-name" visibleFrom="sm">{session.workspace.name}</Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Box className="operator-identity" visibleFrom="xs">
            <Text size="sm" fw={550} truncate>{session.user.name}</Text>
            <Text size="xs" c="dimmed" truncate>{session.role}</Text>
          </Box>
          <ActionIcon variant="subtle" color="gray" size={44} onClick={logout} aria-label="Log out"><IconLogout2 size={18}/></ActionIcon>
        </Group>
      </Group>
    </AppShell.Header>
    <AppShell.Navbar className="app-navbar" p="sm">
      <AppShell.Section grow>
        <Text className="nav-section-label">Workspace</Text>
        <Stack gap={4}>{nav.filter(item=>has(session,item.permission)).map(item=>{
          const Icon=item.icon;
          const active=location.pathname===item.to||(item.to!=='/'&&location.pathname.startsWith(item.to));
          return <NavLink key={item.to} component={Link} to={item.to} label={item.label} leftSection={<Icon size={17} stroke={1.7}/>} active={active} onClick={close}/>;
        })}</Stack>
      </AppShell.Section>
      <AppShell.Section className="nav-footer">
        <Group gap="xs" wrap="nowrap"><IconAdjustments size={15}/><Text size="xs" c="dimmed" truncate>{session.workspace.name}</Text></Group>
      </AppShell.Section>
    </AppShell.Navbar>
    <AppShell.Main><PageContainer><Routes>
      <Route path="/" element={<Overview/>}/>
      <Route path="/endpoints" element={<Guard session={session} permission="endpoint:read"><Endpoints session={session}/></Guard>}/>
      <Route path="/endpoints/:id" element={<Guard session={session} permission="endpoint:read"><EndpointDetail session={session}/></Guard>}/>
      <Route path="/nodes" element={<Guard session={session} permission="node:read"><Nodes session={session}/></Guard>}/>
      <Route path="/nodes/:id" element={<Guard session={session} permission="node:read"><NodeDetail/></Guard>}/>
      <Route path="/providers" element={<Guard session={session} permission="provider:read"><Providers/></Guard>}/>
      <Route path="/operations" element={<Guard session={session} permission="operation:read"><Operations/></Guard>}/>
      <Route path="/operations/:id" element={<Guard session={session} permission="operation:read"><OperationDetail/></Guard>}/>
      <Route path="/audit" element={<Guard session={session} permission="audit:read"><Audit/></Guard>}/>
      <Route path="/workspace" element={<Navigate to="/workspace/members"/>}/>
      <Route path="/workspace/members" element={<Guard session={session} permission="member:read"><Members session={session}/></Guard>}/>
      <Route path="/workspace/credentials" element={<Guard session={session} permission="credential:read"><Credentials session={session}/></Guard>}/>
      <Route path="/workspace/settings" element={<Guard session={session} permission="settings:read"><Settings session={session}/></Guard>}/>
      <Route path="*" element={<NotFound/>}/>
    </Routes></PageContainer></AppShell.Main>
  </AppShell>;
}

function Authenticated(){
  const location=useLocation();
  const q=useQuery({queryKey:['session'],queryFn:()=>api.get<Session>('/auth/session'),retry:false});
  if(q.isLoading)return <Loading fullPage label="Loading workspace"/>;
  if(q.error)return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname+location.search)}`} replace/>;
  return <Shell session={q.data!}/>;
}
function RoutesRoot(){return <Routes><Route path="/login" element={<Login/>}/><Route path="*" element={<Authenticated/>}/></Routes>}
export function ConsoleApp(){
  const client=newClient();activeClient=client;
  const isTest=typeof navigator!=='undefined'&&navigator.userAgent.includes('jsdom');
  return <MantineProvider theme={theme} defaultColorScheme="dark" env={isTest?'test':'default'}><QueryClientProvider client={client}><BrowserRouter><RoutesRoot/></BrowserRouter></QueryClientProvider></MantineProvider>;
}
