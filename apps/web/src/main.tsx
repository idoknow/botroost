import {StrictMode} from 'react';import {createRoot} from 'react-dom/client';import {MantineProvider} from '@mantine/core';import {ConsoleApp} from './app';
createRoot(document.getElementById('root')!).render(<StrictMode><MantineProvider defaultColorScheme="dark"><ConsoleApp/></MantineProvider></StrictMode>);
