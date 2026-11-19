import { createRoot } from 'react-dom/client';
import './log';
import App from './App';
import PartnerRecorder from './PartnerRecorder';
import './styles.css';

// …/#partner — страница записи реплик для партнёра, всё остальное — основное приложение актёра.
const isPartner = location.hash === '#partner';
createRoot(document.getElementById('root')!).render(isPartner ? <PartnerRecorder /> : <App />);
window.addEventListener('hashchange', () => location.reload());
