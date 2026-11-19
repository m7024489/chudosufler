import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// basicSsl даёт самоподписанный HTTPS для теста с телефона в локальной сети.
export default defineConfig({
  base: './',
  plugins: [react(), basicSsl()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
