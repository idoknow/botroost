import '@mantine/core/styles.css';
import './styles.css';
import {ActionIcon,AppShell,Box,Divider,Group,MantineProvider,Menu,NavLink,Stack,Text,createTheme} from '@mantine/core';
import {IconActivity,IconAdjustments,IconBuilding,IconCloud,IconDatabase,IconDots,IconFileAnalytics,IconLogout2,IconServer,IconTopologyStar} from '@tabler/icons-react';
import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
import type {ReactNode} from 'react';
import {BrowserRouter,Link,Navigate,Route,Routes,useLocation,useNavigate} from 'react-router-dom';
import {api} from './api';
import {Login} from './login';
import {Audit,Credentials,EndpointDetail,Endpoints,Members,NodeDetail,Nodes,OperationDetail,Operations,Overview,Providers,Settings} from './pages';
import {Loading,NotFound} from './states';
import type {Session} from './types';
import {BrandMark,PageContainer} from './ui';
import {ThemeModeControl} from './theme-control';

const theme=createTheme({
  primaryColor:'blue',
  primaryShade:6,
  fontFamily:'"PingFang SC", "Microsoft YaHei", Inter, system-ui, -apple-system, sans-serif',
  fontFamilyMonospace:'"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
  headings:{fontFamily:'"PingFang SC", "Microsoft YaHei", Inter, system-ui, -apple-system, sans-serif',fontWeight:'650'},
  defaultRadius:'sm',
  radius:{xs:'4px',sm:'6px',md:'10px',lg:'10px',xl:'10px'},
  spacing:{xs:'8px',sm:'12px',md:'16px',lg:'24px',xl:'32px'},
  colors:{blue:['#eff6ff','#dbeafe','#bfdbfe','#93c5fd','#60a5fa','#3b82f6','#2563eb','#1d4ed8','#1e40af','#1e3a8a']},
  components:{Button:{defaultProps:{radius:'md'}},Card:{defaultProps:{radius:'sm',withBorder:true}},Paper:{defaultProps:{radius:'sm'}},TextInput:{defaultProps:{radius:'sm'}},PasswordInput:{defaultProps:{radius:'sm'}},Select:{defaultProps:{radius:'sm'}},Modal:{defaultProps:{radius:'md',overlayProps:{backgroundOpacity:.55,blur:2}}}},
});

const newClient=()=>new QueryClient({defaultOptions:{queries:{staleTime:15_000,retry:false}}});
let activeClient:QueryClient|undefined;
const nav=[
  {label:'Cluster',to:'/',permission:'workspace:read',icon:IconActivity},
  {label:'Protocol endpoints',to:'/endpoints',permission:'endpoint:read',icon:IconTopologyStar},
  {label:'Agent nodes',to:'/nodes',permission:'node:read',icon:IconServer},
  {label:'Runtime drivers',to:'/providers',permission:'provider:read',icon:IconCloud},
  {label:'Changes',to:'/operations',permission:'operation:read',icon:IconDatabase},
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
  const location=useLocation();
  const navigate=useNavigate();
  async function logout(){await api.mutate('/auth/logout');activeClient?.clear();navigate('/login',{replace:true})}
  const visible=nav.filter(item=>has(session,item.permission));
  const mobilePrimary=visible.filter(item=>['/','/endpoints','/nodes','/operations'].includes(item.to));
  const mobileMore=visible.filter(item=>!mobilePrimary.includes(item));
  return <AppShell header={{height:56}} navbar={{width:190,breakpoint:'sm',collapsed:{mobile:true}}} padding={0}>
    <AppShell.Header className="app-header">
      <Group h="100%" px={{base:'sm',sm:'md'}} justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <BrandMark/>
          <Divider orientation="vertical" h={24} visibleFrom="sm"/>
          <Text className="workspace-name" visibleFrom="sm">{session.workspace.name}</Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Box className="operator-identity" visibleFrom="xs">
            <Text size="sm" fw={550} truncate>{session.user.name}</Text>
            <Text size="xs" c="dimmed" truncate>{session.role}</Text>
          </Box>
          <ThemeModeControl/>
          <ActionIcon variant="subtle" color="gray" size={40} onClick={logout} aria-label="Log out"><IconLogout2 size={18}/></ActionIcon>
        </Group>
      </Group>
    </AppShell.Header>
    <AppShell.Navbar className="app-navbar" p="sm">
      <AppShell.Section grow>
        <Text className="nav-section-label">OneBot cluster</Text>
        <Stack gap={4}>{visible.map(item=>{
          const Icon=item.icon;
          const active=location.pathname===item.to||(item.to!=='/'&&location.pathname.startsWith(item.to));
          return <NavLink key={item.to} component={Link} to={item.to} label={item.label} leftSection={<Icon size={17} stroke={1.7}/>} active={active}/>;
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
    <nav className="mobile-tabbar" aria-label="Primary navigation">{mobilePrimary.map(item=>{const Icon=item.icon;const active=location.pathname===item.to||(item.to!=='/'&&location.pathname.startsWith(item.to));return <Link key={item.to} to={item.to} className={active?'mobile-tab is-active':'mobile-tab'} aria-current={active?'page':undefined}><Icon size={20}/><span>{item.label==='Protocol endpoints'?'Endpoints':item.label==='Agent nodes'?'Nodes':item.label==='Changes'?'Changes':'Cluster'}</span></Link>})}{mobileMore.length>0&&<Menu position="top-end" withinPortal><Menu.Target><button className={mobileMore.some(item=>location.pathname.startsWith(item.to))?'mobile-tab is-active':'mobile-tab'}><IconDots size={20}/><span>More</span></button></Menu.Target><Menu.Dropdown>{mobileMore.map(item=>{const Icon=item.icon;return <Menu.Item key={item.to} component={Link} to={item.to} leftSection={<Icon size={16}/>}>{item.label}</Menu.Item>})}</Menu.Dropdown></Menu>}</nav>
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
  return <MantineProvider theme={theme} defaultColorScheme="auto" env={isTest?'test':'default'}><QueryClientProvider client={client}><BrowserRouter><RoutesRoot/></BrowserRouter></QueryClientProvider></MantineProvider>;
}
