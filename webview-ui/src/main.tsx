import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './AppLocal.tsx';

async function main() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

main().catch(console.error);
