import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootstrapToken } from './lib/storage';
import './styles/tokens.css';
import './styles/app.css';
import './styles/content.css';

bootstrapToken(); // ?token= -> sessionStorage, stripped from the URL (also handles ?server=, ?demo=1)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
