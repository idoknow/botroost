import {Alert,Button,Center,Loader,Stack,Text,ThemeIcon,Title} from '@mantine/core';
import {IconAlertTriangle,IconArrowLeft,IconBox,IconCloudOff,IconFileUnknown} from '@tabler/icons-react';

export function Loading({label='Loading',fullPage=false}:{label?:string;fullPage?:boolean}){
  return <Center className={fullPage?'state state--page':'state'}><Stack align="center" gap="sm"><Loader size="sm" aria-label="Loading"/><Text size="sm" c="dimmed">{label}</Text></Stack></Center>;
}
export function Failure({error}:{error:unknown}){
  const message=error instanceof Error?error.message:'Request failed';
  return <Alert className="state-alert" color="red" variant="light" icon={<IconAlertTriangle size={18}/>} title="Unable to load">{message}</Alert>;
}
export function Empty({name}:{name:string}){
  return <Center className="state state--bounded"><Stack align="center" gap="xs"><ThemeIcon variant="light" color="gray" size={40}><IconBox size={20}/></ThemeIcon><Title order={3}>No {name.toLowerCase()} found</Title><Text c="dimmed" size="sm">There is nothing to display yet.</Text></Stack></Center>;
}
export function Unavailable(){
  return <Alert className="state-alert" color="gray" variant="light" icon={<IconCloudOff size={18}/>} title="Unavailable">This API capability is not available on this server.</Alert>;
}
export function NotFound(){
  return <Center className="state state--not-found"><Stack align="center" gap="sm"><ThemeIcon variant="light" color="gray" size={48}><IconFileUnknown size={24}/></ThemeIcon><Text className="eyebrow">Error 404</Text><Title order={1}>Page not found</Title><Text c="dimmed" ta="center">The requested console route does not exist or is not available to your role.</Text><Button component="a" href="/" variant="light" leftSection={<IconArrowLeft size={16}/>} mt="xs">Return to overview</Button></Stack></Center>;
}
