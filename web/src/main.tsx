import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { SessionProvider } from './lib/session';
import { CartProvider } from './lib/cart';
import { ToastProvider } from './components/ui';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing from index.html');

createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <ToastProvider>
          <CartProvider>
            <App />
          </CartProvider>
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
