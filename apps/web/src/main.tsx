import '@fontsource-variable/geist';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Toaster} from 'sonner';
import {ConsoleApp} from './app';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConsoleApp/>
    <Toaster richColors position="bottom-right"/>
  </StrictMode>,
);
