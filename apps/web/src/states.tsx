import {Alert,Button,Group,Loader,Stack,Text,Title} from '@mantine/core';
export function Loading(){return <Group justify="center" p="xl"><Loader aria-label="Loading"/></Group>}
export function Failure({error}:{error:unknown}){const message=error instanceof Error?error.message:'Request failed';return <Alert color="red" title="Unable to load">{message}</Alert>}
export function Empty({name}:{name:string}){return <Stack align="center" p="xl"><Title order={3}>No {name.toLowerCase()} found</Title><Text c="dimmed">There is nothing to display yet.</Text></Stack>}
export function Unavailable(){return <Alert color="gray" title="Unavailable">This API capability is not available on this server.</Alert>}
export function NotFound(){return <Stack align="center" p="xl"><Title>Page not found</Title><Button component="a" href="/">Return to overview</Button></Stack>}
