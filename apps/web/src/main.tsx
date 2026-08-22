import '@fontsource-variable/geist';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Toaster} from 'sonner';
import {ConsoleApp} from './app';
import {LocaleProvider} from './i18n';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleProvider>
      <ConsoleApp/>
      <Toaster richColors position="bottom-right"/>
    </LocaleProvider>
  </StrictMode>,
);
