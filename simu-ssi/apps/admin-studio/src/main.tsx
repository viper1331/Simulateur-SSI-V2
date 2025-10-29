import React from 'react';
import ReactDOM from 'react-dom/client';
import { AdminStudioApp } from './pages/AdminStudioApp';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AdminStudioApp />
  </React.StrictMode>,
);
