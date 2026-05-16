import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../globals.css';
import { EditorApp } from './App';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <EditorApp />
    </StrictMode>,
  );
}
