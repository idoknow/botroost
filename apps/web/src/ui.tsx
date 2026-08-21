import {Box,Container,Group,Text} from '@mantine/core';
import type {ReactNode} from 'react';

export function BrandMark({compact=false}:{compact?:boolean}){
  return <Group gap="sm" wrap="nowrap" className="brand-lockup">
    <Box className="brand-mark" aria-hidden="true"><span/><span/><span/></Box>
    {!compact&&<div><Text className="brand-name">Botroost</Text><Text className="brand-kicker">Control plane</Text></div>}
  </Group>;
}

export function PageContainer({children}:{children:ReactNode}){
  return <Container fluid className="page-container">{children}</Container>;
}
