import { createRoot } from 'react-dom/client';
import './log';
import App from './App';
import PartnerRecorder from './PartnerRecorder';
import './styles.css';

// …/#partner — страница записи реплик для партнёра, всё остальное — основное приложение актёра.
// …/#record — та же страница записи, но на телефоне актёра: записи сохраняются сразу.
const h = location.hash;
createRoot(document.getElementById('root')!).render(
  h === '#partner' ? <PartnerRecorder mode="partner" /> : h === '#record' ? <PartnerRecorder mode="self" /> : <App />,
);
window.addEventListener('hashchange', () => location.reload());
