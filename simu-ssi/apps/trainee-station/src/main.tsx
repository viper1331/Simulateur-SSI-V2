import React from 'react';
import ReactDOM from 'react-dom/client';
import { TraineeApp } from './pages/TraineeApp';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <TraineeApp />
  </React.StrictMode>,
);
