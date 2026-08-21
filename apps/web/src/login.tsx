import {Alert,Button,Center,Paper,PasswordInput,Stack,Text,TextInput,Title} from '@mantine/core';
import {IconAlertCircle,IconArrowRight} from '@tabler/icons-react';
import {useState} from 'react';
import {api} from './api';
import {BrandMark} from './ui';

export function Login(){
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string>();
  async function submit(e:React.FormEvent){
    e.preventDefault();setBusy(true);setError(undefined);
    try{
      await api.login({email,password});
      const requested=new URLSearchParams(location.search).get('returnTo');
      const target=requested?.startsWith('/')&&!requested.startsWith('//')?requested:'/';
      history.replaceState({},'',target);dispatchEvent(new PopStateEvent('popstate'));
    }catch(reason){setError(reason instanceof Error?reason.message:'Unable to sign in');}
    finally{setBusy(false)}
  }
  return <main className="login-page">
    <div className="login-grid" aria-hidden="true"/>
    <Center className="login-stage">
      <Stack className="login-wrap" gap="xl">
        <BrandMark/>
        <Paper component="section" className="login-panel" withBorder p={{base:'lg',sm:'xl'}}>
          <form onSubmit={submit}>
            <Stack gap="md">
              <div><Text className="eyebrow">OneBot Cluster</Text><Title order={1}>Sign in</Title><Text c="dimmed" mt={6}>Manage cloud-native OneBot protocol endpoints and their agent nodes.</Text></div>
              {error&&<Alert icon={<IconAlertCircle size={18}/>} color="red" title="Authentication failed">{error}</Alert>}
              <TextInput label="Email" type="email" autoComplete="email" autoFocus required value={email} onChange={e=>setEmail(e.currentTarget.value)}/>
              <PasswordInput label="Password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.currentTarget.value)}/>
              <Button type="submit" loading={busy} rightSection={<IconArrowRight size={17}/>}>Sign in</Button>
            </Stack>
          </form>
        </Paper>
        <Text size="xs" c="dimmed" className="login-footnote">OneBot endpoint cluster console · Authenticated access only</Text>
      </Stack>
    </Center>
  </main>;
}
