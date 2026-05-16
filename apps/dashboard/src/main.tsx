import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';

import App from './App';
import './globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: {
      retry: 0,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster
          position="bottom-right"
          gutter={8}
          toastOptions={{
            duration: 3500,
            style: {
              background: '#1a1f2e',
              color: '#f9fafb',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '12px',
              fontSize: '14px',
              fontFamily: 'Inter, system-ui, sans-serif',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              padding: '12px 16px',
            },
            success: {
              iconTheme: { primary: '#34d399', secondary: '#1a1f2e' },
            },
            error: {
              iconTheme: { primary: '#f87171', secondary: '#1a1f2e' },
            },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
