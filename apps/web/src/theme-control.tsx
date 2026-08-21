import {ActionIcon,Menu,Text} from '@mantine/core';
import {IconCheck,IconDeviceDesktop,IconMoon,IconSun} from '@tabler/icons-react';
import {useMantineColorScheme} from '@mantine/core';

const choices=[
  {value:'light' as const,label:'Light',description:'Use the light interface',icon:IconSun},
  {value:'dark' as const,label:'Dark',description:'Use the dark interface',icon:IconMoon},
  {value:'auto' as const,label:'System',description:'Follow your device',icon:IconDeviceDesktop},
];

export function ThemeModeControl(){
  const {colorScheme,setColorScheme}=useMantineColorScheme();
  const Current=colorScheme==='dark'?IconMoon:colorScheme==='light'?IconSun:IconDeviceDesktop;
  return <Menu position="bottom-end" width={220} shadow="md">
    <Menu.Target><ActionIcon variant="subtle" color="gray" size={40} aria-label="Appearance"><Current size={18}/></ActionIcon></Menu.Target>
    <Menu.Dropdown><Menu.Label>Appearance</Menu.Label>{choices.map(choice=>{const Icon=choice.icon;return <Menu.Item key={choice.value} leftSection={<Icon size={16}/>} rightSection={colorScheme===choice.value?<IconCheck size={15}/>:null} onClick={()=>setColorScheme(choice.value)}><Text size="sm" fw={600}>{choice.label}</Text><Text size="xs" c="dimmed">{choice.description}</Text></Menu.Item>})}</Menu.Dropdown>
  </Menu>;
}
