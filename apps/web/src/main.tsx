import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app';
import { ThemeProvider } from './theme';
import { createQueryClient } from './lib/query-client';
import { clearNewsEditDrafts } from './lib/news-edit-drafts';
import './styles.css';
import './redesign.css';

const queryClient = createQueryClient();
clearNewsEditDrafts();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
